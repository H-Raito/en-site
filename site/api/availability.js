// 空室カレンダー用API。指定範囲の予約済み宿泊夜と受付停止日を返す。
import { getStore } from '../lib/store.js';
import { tokyoToday, parseDate, fmtUTC, dateToUTC } from '../lib/util.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const store = await getStore();
  await store.expireStale();
  const today = tokyoToday();
  const todayMs = dateToUTC(parseDate(today));
  const q = req.url.split('?')[1] || '';
  const params = new URLSearchParams(q);
  const months = Math.min(Math.max(parseInt(params.get('months') || '3', 10) || 3, 1), 6);
  const from = new Date(todayMs);
  from.setUTCMonth(from.getUTCMonth(), 1);
  const to = new Date(todayMs);
  to.setUTCMonth(to.getUTCMonth() + months);
  const fromStr = fmtUTC(from.getTime());
  const toStr = fmtUTC(to.getTime() - 86400000);
  try {
    const { bookedNights, blockedDates } = await store.availability(fromStr, toStr);
    res.status(200).json({
      from: fromStr,
      to: toStr,
      today,
      booked: [...bookedNights].sort(),
      blocked: [...blockedDates].sort(),
      paymentsEnabled: paymentsEnabled(),
    }
    );
  } catch (err) {
    if (err.code === 'not_configured') {
      res.status(503).json({ error: 'not_configured', booked: [], blocked: [], today, paymentsEnabled: false });
      return;
    }
    console.error('availability error:', err);
    res.status(500).json({ error: 'internal error' });
  }
}

export function paymentsEnabled() {
  return process.env.BOOKING_PAYMENTS_ENABLED === 'true' && !!process.env.STRIPE_SECRET_KEY;
}
