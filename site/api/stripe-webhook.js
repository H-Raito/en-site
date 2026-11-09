// Stripe Webhook（正式な決済結果反映経路）。ブラウザが戻らなくても予約が確定する。
// 冪等: confirmBooking の排他的遷移で重複配信も安全。対応イベント: completed/expired/refunded。
// VercelのNode.jsヘルパは本文を自動パースして再整形するため、署名検証に必要な生本文が
// 失われる。ここだけ Web 標準の fetch スタイルで受け、request.text() で生本文を読む。
import { getStore } from '../lib/store.js';
import { confirmAndNotify } from '../lib/confirm.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return jsonRes(405, { received: false });
    }
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !process.env.STRIPE_SECRET_KEY) {
      return jsonRes(503, { received: false, error: 'stripe not configured' });
    }
    const raw = await request.text();
    const sig = request.headers.get('stripe-signature');
    if (!raw || !sig) {
      return jsonRes(400, { received: false, error: 'invalid body' });
    }
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    let event;
    try {
      event = stripe.webhooks.constructEvent(raw, sig, secret);
    } catch (err) {
      console.error('webhook signature error:', err.message);
      return jsonRes(400, { received: false, error: 'invalid signature' });
    }
    try {
      await handleEvent(event);
      return jsonRes(200, { received: true });
    } catch (err) {
      /* 処理失敗は500でStripe再送に委ねる（confirmBookingが冪等なので安全） */
      console.error('webhook processing error:', err);
      return jsonRes(500, { received: false });
    }
  },
};

function jsonRes(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
