// 予約状態参照（公開・限定フィールド）。戻り先ページが確定状況を表示するために使う。
import { getStore } from '../lib/store.js';
import { maskName } from '../lib/util.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const q = new URLSearchParams((req.url.split('?')[1]) || '');
  const id = q.get('id') || '';
  if (!/^EN-[A-Z0-9-]{4,40}$/.test(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  try {
    const store = await getStore();
    await store.expireStale();
    const b = await store.getBooking(id);
    if (!b) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(200).json({
      id: b.id,
      checkin: b.checkin,
      checkout: b.checkout,
      nights: b.nights,
      adults: b.adults,
      infants: b.infants,
      guestNameMasked: maskName(b.guest_name),
      status: b.status,
      priceJpy: b.price_jpy,
      emailStatus: b.email_status,
      options: b.options || {},
    });
  } catch (err) {
    if (err.code === 'not_configured') {
      res.status(503).json({ error: 'not_configured' });
      return;
    }
    console.error('booking-status error:', err);
    res.status(500).json({ error: 'internal error' });
  }
}
