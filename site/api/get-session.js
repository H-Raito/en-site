// 決済成功戻り時にセッションを検証し、予約情報（metadata）を返す。
import Stripe from 'stripe';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// 分割された metadata(bj0,bj1,…) を結合して予約JSONを復元する。
function readBookingMeta(metadata) {
  if (!metadata) return {};
  const keys = Object.keys(metadata).filter(function (k) { return k.indexOf('bj') === 0; });
  keys.sort(function (a, b) { return parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10); });
  const s = keys.map(function (k) { return metadata[k]; }).join('');
  try { return s ? JSON.parse(s) : {}; } catch (e) { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!stripe) {
    res.status(500).json({ error: 'STRIPE_SECRET_KEY is not configured' });
    return;
  }
  const sessionId = req.query && req.query.session_id;
  if (!sessionId || typeof sessionId !== 'string') {
    res.status(400).json({ error: 'missing session_id' });
    return;
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    res.status(200).json({
      status: session.payment_status,
      total: session.amount_total,
      booking: readBookingMeta(session.metadata)
    });
  } catch (err) {
    console.error('Stripe session retrieve error:', err);
    res.status(500).json({ error: 'failed to retrieve session' });
  }
}
