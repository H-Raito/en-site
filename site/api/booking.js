// 予約作成API。
// 流れ: 検証 → 決済有効確認 → 空室確保（トランザクション・30分仮押さえ） → Stripe Checkout生成。
// クライアントが送った金額は一切使わない。金額・泊数はサーバー再計算値を保存する。
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

  /* 1. 予約条件の検証（サーバー最終防壁） */
  const v = validateBookingInput({
    checkin: body.checkin,
    checkout: body.checkout,
    adults: parseInt(body.adults, 10),
    children: body.children == null ? 0 : parseInt(body.children, 10),
  }, tokyoToday());
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

  /* 3. オプションは「希望受付」。金額には含めず当日現金払いとして記録する */
  const options = {
    bbq: !!body.bbq,
    sauna: !!body.sauna,
    earlyCheckin: !!body.earlyCheckin,
  };

  /* 4. 決済が有効か（正式料金承認 + Stripeキー設定済みのときだけ有効化する運用） */
  const paymentsEnabled = process.env.BOOKING_PAYMENTS_ENABLED === 'true' && !!process.env.STRIPE_SECRET_KEY;
  if (!paymentsEnabled) {
    res.status(503).json({ error: 'payments_disabled' });
    return;
  }

  const store = await getStore();
  await store.expireStale();

  /* 5. リトライ時の冪等: 同一 request_id の未完了予約があれば再利用 */
  const requestId = typeof body.request_id === 'string' ? body.request_id.slice(0, 64) : '';
  if (requestId) {
    const existing = await store.getBookingByRequest(requestId);
    if (existing && existing.status === 'pending_payment' && existing.stripe_session_id) {
      const reuse = await reuseSession(existing.stripe_session_id, existing.id);
      if (reuse) {
        res.status(200).json({ bookingId: existing.id, url: reuse, reused: true });
        return;
      }
    }
  }

  const price = computePrice(v.adults, v.nights);

  /* 6. 空室確保（トランザクション・30分仮押さえ） */
  let booking;
  try {
    booking = await store.createPendingBooking({
      request_id: requestId || null,
      checkin: body.checkin,
      checkout: body.checkout,
      nights: v.nights,
      adults: v.adults,
      children: v.children,
      guest_name: guestName,
      guest_kana: kana,
      guest_email: email,
      guest_phone: phone,
      guest_address: address,
      arrival_time: arrival,
      notes,
      options,
      price_jpy: price.total,
      price_detail: price,
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

  /* 7. Stripe Checkout セッション生成（予約IDを紐付け・30分で失効） */
  try {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
          unit_amount: price.total,
          product_data: {
            name: 'EN 宿泊料（' + v.nights + '泊 / 大人' + v.adults + '名' + (v.children ? ' + 乳幼児' + v.children + '名' : '') + '）',
            description: body.checkin + ' 〜 ' + body.checkout,
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
    /* 決済ページ生成に失敗したら仮押さえを解除（キャンセル扱い） */
    try { await store.setBookingStatus(booking.id, 'cancelled', { memo: 'stripe session error' }); } catch (e2) {}
    res.status(502).json({ error: 'stripe_error' });
  }
}

async function reuseSession(sessionId, bookingId) {
  try {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
