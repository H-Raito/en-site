// Stripe Checkout セッション生成（EN 貸切宿・全額事前決済）
// 金額はサーバー側で再計算し、クライアントからの金額は一切信用しない。
import Stripe from 'stripe';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// 料金モデル（index/script.js と同一・1泊あたり税込。上乗せの消費税は加算しない）
const BASE_GUESTS = 4;
const BASE_PRICE = 48000;
const EXTRA_PER_GUEST = 6000;
const MAX_GUESTS = 10;
const OPTION_BBQ = 1000;
const OPTION_SAUNA = 1000;
const MAX_BODY_BYTES = 65536; // 64KB 上限

function computePrice(adults, nights, bbq, sauna) {
  const perNight = BASE_PRICE + EXTRA_PER_GUEST * Math.max(0, adults - BASE_GUESTS);
  const staySubtotal = perNight * Math.max(nights, 0);
  const optionsTotal = (bbq ? OPTION_BBQ : 0) + (sauna ? OPTION_SAUNA : 0);
  const total = staySubtotal + optionsTotal;
  return { perNight, staySubtotal, optionsTotal, total };
}

function cap(v, n) {
  return typeof v === 'string' ? v.slice(0, n) : '';
}

// 予約JSON を480文字毎の metadata キー(bj0,bj1,…)に分割。全文を事業者通知メールまで届ける。
function buildMetadata(booking) {
  const s = JSON.stringify(booking);
  const meta = {};
  let i = 0;
  for (let off = 0; off < s.length; off += 480) {
    meta['bj' + i] = s.slice(off, off + 480);
    i++;
  }
  return meta;
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      raw += c;
      if (raw.length > MAX_BODY_BYTES) { tooLarge = true; resolve({}); }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function originFrom(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return proto + '://' + host;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!stripe) {
    res.status(500).json({ error: 'STRIPE_SECRET_KEY is not configured' });
    return;
  }

  const b = await readBody(req);

  const nights = parseInt(b.nights, 10);
  const adults = parseInt(b.adults, 10);
  if (!nights || nights < 1) {
    res.status(400).json({ error: 'invalid nights' });
    return;
  }
  if (!adults || adults < 1 || adults > MAX_GUESTS) {
    res.status(400).json({ error: 'invalid adults' });
    return;
  }
  const bbq = !!b.bbq;
  const sauna = !!b.sauna;
  const infants = parseInt(b.infants, 10) || 0;

  const price = computePrice(adults, nights, bbq, sauna);

  // JPY はゼロ小数通貨（unit_amount = 円）
  const lineItems = [
    {
      quantity: 1,
      price_data: {
        currency: 'jpy',
        unit_amount: price.staySubtotal,
        product_data: { name: '宿泊料（' + nights + '泊 / 大人' + adults + '名）' }
      }
    }
  ];
  if (bbq) {
    lineItems.push({ quantity: 1, price_data: { currency: 'jpy', unit_amount: OPTION_BBQ, product_data: { name: 'BBQコンロ貸出' } } });
  }
  if (sauna) {
    lineItems.push({ quantity: 1, price_data: { currency: 'jpy', unit_amount: OPTION_SAUNA, product_data: { name: 'テントサウナ貸出' } } });
  }

  const origin = originFrom(req);
  const customerEmail = b.email && String(b.email).includes('@') ? b.email : undefined;

  const booking = {
    name: cap(b.name, 40),
    email: cap(b.email, 80),
    phone: cap(b.phone, 20),
    zip: cap(b.zip, 10),
    prefecture: cap(b.prefecture, 10),
    address: cap(b.address, 60),
    arrival: cap(b.arrival, 8),
    notes: cap(b.notes, 300),
    checkin: cap(b.checkin, 12),
    checkout: cap(b.checkout, 12),
    nights, adults, infants, bbq, sauna,
    perNight: price.perNight,
    staySubtotal: price.staySubtotal,
    optionsTotal: price.optionsTotal,
    total: price.total
  };

  // クライアント生成の冪等キー（再送・二重決済防止）。英数字・記号のみに sanitise。
  const idemRaw = typeof b.idempotency_key === 'string' ? b.idempotency_key.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
  const stripeOpts = idemRaw ? { idempotency_key: 'en_' + idemRaw } : {};

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      success_url: origin + '/?booking=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: origin + '/#reserve',
      customer_email: customerEmail,
      metadata: buildMetadata(booking)
    }, stripeOpts);
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe session create error:', err);
    res.status(500).json({ error: 'failed to create checkout session' });
  }
}
