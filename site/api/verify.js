// 決済戻り検証。Stripeセッションをサーバー側で取得し、支払済みなら予約を確定へ遷移させる。
// 冪等: webhook と二重に走っても status 遷移の排他で安全。
import { getStore } from '../lib/store.js';
import { confirmAndNotify } from '../lib/confirm.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const q = new URLSearchParams((req.url.split('?')[1]) || '');
  const id = q.get('id') || '';
  const sessionId = q.get('session_id') || '';
  if (!/^EN-[A-Z0-9-]{4,40}$/.test(id) || !/^cs_(test|live)_?[A-Za-z0-9]+$/.test(sessionId)) {
    res.status(400).json({ error: 'invalid params' });
    return;
  }
  try {
    const store = await getStore();
    const b0 = await store.getBooking(id);
    if (!b0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (b0.status === 'pending_payment') {
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status === 'paid' && (session.client_reference_id === id || (session.metadata && session.metadata.booking_id === id))) {
        await confirmAndNotify(store, id, session.payment_intent || null);
      }
    }
    const b = await store.getBooking(id);
    res.status(200).json(publicView(b));
  } catch (err) {
    if (err.code === 'not_configured') {
      res.status(503).json({ error: 'not_configured' });
      return;
    }
    console.error('verify error:', err);
    res.status(500).json({ error: 'internal error' });
  }
}

function publicView(b) {
  return {
    id: b.id, checkin: b.checkin, checkout: b.checkout, nights: b.nights,
    adults: b.adults, infants: b.infants, status: b.status,
    priceJpy: b.price_jpy, emailStatus: b.email_status,
    guestNameMasked: (b.guest_name || '')[0] ? b.guest_name[0] + '○' : '',
    options: b.options || {},
  };
}
