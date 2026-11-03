// Stripe Webhook（正式な決済結果反映経路）。ブラウザが戻らなくても予約が確定する。
// 冪等: confirmBooking の排他的遷移で重複配信も安全。対応イベント: completed/expired/refunded。
import { getStore } from '../lib/store.js';
import { confirmAndNotify } from '../lib/confirm.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ received: false });
    return;
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) {
    res.status(503).json({ received: false, error: 'stripe not configured' });
    return;
  }
  const raw = await readRaw(req);
  if (!raw) {
    res.status(400).json({ received: false, error: 'invalid body' });
    return;
  }
  const sig = req.headers && req.headers['stripe-signature'];
  if (!sig) {
    res.status(400).json({ received: false, error: 'missing signature' });
    return;
  }
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error('webhook signature error:', err.message);
    res.status(400).json({ received: false, error: 'invalid signature' });
    return;
  }
  try {
    await handleEvent(event);
    res.status(200).json({ received: true });
  } catch (err) {
    /* 処理失敗は500でStripe再送に委ねる（confirmBookingが冪等なので安全） */
    console.error('webhook processing error:', err);
    res.status(500).json({ received: false });
  }
}

async function handleEvent(event) {
  const store = await getStore();
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const bookingId = s.client_reference_id || (s.metadata && s.metadata.booking_id);
    if (bookingId && s.payment_status === 'paid') {
      await confirmAndNotify(store, bookingId, s.payment_intent || null);
    }
    return;
  }
  if (event.type === 'checkout.session.expired') {
    const s = event.data.object;
    const bookingId = s.client_reference_id || (s.metadata && s.metadata.booking_id);
    if (bookingId) {
      const b = await store.getBooking(bookingId);
      if (b && b.status === 'pending_payment') {
        await store.setBookingStatus(bookingId, 'expired');
      }
    }
    return;
  }
  if (event.type === 'charge.refunded') {
    const ch = event.data.object;
    if (ch.payment_intent) {
      const list = await store.listBookings({});
      const b = list.find((x) => x.payment_intent_id === ch.payment_intent);
      if (b && b.status === 'confirmed') {
        await store.setBookingStatus(b.id, 'refunded', { memo: 'charge.refunded webhook' });
        await store.logAdmin('booking_refunded', { id: b.id, payment_intent: ch.payment_intent });
      }
    }
  }
}

function readRaw(req) {
  return new Promise((resolve) => {
    if (typeof req.body === 'string') return resolve(req.body);
    if (req.body && typeof req.body === 'object') return resolve(JSON.stringify(req.body));
    let raw = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      raw += c;
      if (raw.length > 262144) { tooLarge = true; resolve(''); }
    });
    req.on('end', () => { if (!tooLarge) resolve(raw); });
    req.on('error', () => resolve(''));
  });
}
