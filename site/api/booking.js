// 予約作成API（2026-11 確定仕様）。
// 検証 → 決済有効確認 → 期限チェック → 空室確保（30分仮押さえ）→ Stripe Checkout生成。
// 金額・泊数・人数区分はすべてサーバー再計算。オプションは支払方法に応じて同梱/現地払いを分離。
import { getStore } from '../lib/store.js';
import { tokyoToday, parseDate, isValidEmail, isValidPhone, isKana, capStr } from '../lib/util.js';
import { computePrice, validateBookingInput, PRICING } from '../lib/pricing.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const body = await readBody(req);
  if (!body) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }

  /* 1. 日程・人数の検証（期限・実人数上限を含むサーバー最終防壁） */
  const v = validateBookingInput({
    checkin: body.checkin,
    checkout: body.checkout,
    adults: parseInt(body.adults, 10),
    infants: body.infants == null ? 0 : parseInt(body.infants, 10),
    paymentMethod: body.paymentMethod,
  }, tokyoToday(), Date.now());
  if (!v.ok) {
    res.status(400).json({ error: v.error });
    return;
  }

  /* 2. お客様情報の検証 */
  const guestName = capStr(String(body.name || '').trim(), 60);
  const kana = capStr(String(body.kana || '').trim(), 60);
  const email = capStr(String(body.email || '').trim(), 120);
  const phone = capStr(String(body.phone || '').trim(), 20);
  const address = capStr(String(body.address || '').trim(), 120);
  const arrival = capStr(String(body.arrival || '').trim(), 10);
  const notes = capStr(String(body.notes || '').trim(), 500);
  if (!guestName) return fail(res, 'invalid_name');
  if (kana && !isKana(kana)) return fail(res, 'invalid_kana');
  if (!isValidEmail(email)) return fail(res, 'invalid_email');
  if (!isValidPhone(phone)) return fail(res, 'invalid_phone');

  /* 3. オプション。アーリーチェックインは希望記録のみ（承認制・徴収しない） */
  const options = {
    bbq: !!body.bbq,
    sauna: !!body.sauna,
    earlyCheckin: !!body.earlyCheckin,
  };
  const paymentMethod = body.paymentMethod === 'onsite' ? 'onsite' : 'online';
  const price = computePrice(v.adults, v.nights, options, paymentMethod);

  /* 4. 決済が有効か（安全装置: BOOKING_PAYMENTS_ENABLED=true + Stripeキー設定時のみ） */
  const paymentsEnabled = process.env.BOOKING_PAYMENTS_ENABLED === 'true' && !!process.env.STRIPE_SECRET_KEY;
  if (!paymentsEnabled) {
    res.status(503).json({ error: 'payments_disabled' });
    return;
  }

  const store = await getStore();
  await store.expireStale();

  /* 5. 冪等: 同一 request_id の未完了予約は同じCheckout URLを再利用 */
  const requestId = typeof body.request_id === 'string' ? body.request_id.slice(0, 64) : '';
  if (requestId) {
    const existing = await store.getBookingByRequest(requestId);
    if (existing && existing.status === 'pending_payment' && existing.stripe_session_id) {
      const reuse = await reuseSession(existing.stripe_session_id);
      if (reuse) {
        res.status(200).json({ bookingId: existing.id, url: reuse, reused: true });
        return;
      }
    }
  }

  /* 6. 空室確保（トランザクション・30分仮押さえ） */
  let booking;
  try {
    booking = await store.createPendingBooking({
      request_id: requestId || null,
      checkin: body.checkin,
      checkout: body.checkout,
      nights: v.nights,
      adults: v.adults,
      infants: v.infants,
      guest_name: guestName,
      guest_kana: kana,
      guest_email: email,
      guest_phone: phone,
      guest_address: address,
      arrival_time: arrival,
      notes,
      options,
      payment_method: paymentMethod,
      options_online: price.optionsOnline,
      options_onsite: price.optionsOnsite,
      online_total: price.onlineTotal,
      onsite_amount: price.onsiteAmount,
      price_jpy: price.onlineTotal,
      price_detail: { ...price, adults: v.adults, nights: v.nights },
      source: 'web',
    });
  } catch (err) {
    if (err.code === 'unavailable') {
      res.status(409).json({ error: 'unavailable' });
      return;
    }
    if (err.code === 'not_configured') {
      res.status(503).json({ error: 'not_configured' });
      return;
    }
    console.error('booking create error:', err);
    res.status(500).json({ error: 'internal error' });
    return;
  }

  /* 7. Stripe Checkout 生成。決済額 = onlineTotal（onsite選択時は宿泊料のみ） */
  try {
    const stripe = await getStripe();
    const origin = originFrom(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      client_reference_id: booking.id,
      metadata: { booking_id: booking.id },
      expires_at: Math.floor(Date.now() / 1000) + 1800,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: PRICING.currency,
          unit_amount: price.onlineTotal,
          product_data: {
            name: 'EN 宿泊料（' + v.nights + '泊 / 3歳以上' + v.adults + '名' + (v.infants ? ' + 2歳以下' + v.infants + '名' : '') + '）',
            description: body.checkin + ' 〜 ' + body.checkout + (paymentMethod === 'onsite' ? ' ／ オプションは現地払い' : ''),
          },
        },
      }],
      customer_email: email,
      success_url: origin + '/?booking=' + encodeURIComponent(booking.id) + '&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: origin + '/?booking=' + encodeURIComponent(booking.id) + '&canceled=1',
    }, requestId ? { idempotency_key: 'en_' + requestId } : {});
    await store.setStripeSession(booking.id, session.id);
    res.status(200).json({ bookingId: booking.id, url: session.url });
  } catch (err) {
    console.error('stripe error:', err);
    try { await store.setBookingStatus(booking.id, 'cancelled', { memo: 'stripe session error' }); } catch (e2) {}
    res.status(502).json({ error: 'stripe_error' });
  }
}

async function getStripe() {
  /* テスト注入用: __enTestStore と同じやり方（Issue #2） */
  if (globalThis.__enTestStripe) return globalThis.__enTestStripe;
  const { default: Stripe } = await import('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

async function reuseSession(sessionId) {
  try {
    const stripe = await getStripe();
    const s = await stripe.checkout.sessions.retrieve(sessionId);
    if (s && s.status === 'open' && s.url) return s.url;
    return null;
  } catch (e) {
    return null;
  }
}

function originFrom(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const proto = (req.headers && req.headers['x-forwarded-proto']) || 'https';
  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'localhost';
  return proto + '://' + host;
}

function fail(res, code) {
  res.status(400).json({ error: code });
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      raw += c;
      if (raw.length > 65536) { tooLarge = true; resolve(null); }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}
