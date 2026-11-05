// 空室カレンダー用API。指定範囲の予約済み宿泊夜と受付停止日を返す。
// from/to（YYYY-MM-DD）指定可。未指定時は当月から6か月分。
import { getStore } from '../lib/store.js';
import { tokyoToday, parseDate, fmtUTC, dateToUTC } from '../lib/util.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const store = await getStore();
    await store.expireStale();
    const today = tokyoToday();
    const todayMs = dateToUTC(parseDate(today));
    const q = new URLSearchParams((req.url.split('?')[1]) || '');

    let fromStr, toStr;
    const pFrom = q.get('from');
    const pTo = q.get('to');
    const fromD = parseDate(pFrom);
    const toD = parseDate(pTo);
    if (fromD && toD && dateToUTC(fromD) <= dateToUTC(toD)) {
      /* 明示範囲（最長13か月に制限） */
      fromStr = pFrom;
      const capped = new Date(dateToUTC(fromD));
      capped.setUTCMonth(capped.getUTCMonth() + 13);
      toStr = dateToUTC(toD) < capped.getTime() ? pTo : fmtUTC(capped.getTime() - 86400000);
    } else {
      const months = Math.min(Math.max(parseInt(q.get('months') || '3', 10) || 3, 1), 6);
      const from = new Date(todayMs);
      from.setUTCMonth(from.getUTCMonth(), 1);
      const to = new Date(todayMs);
      to.setUTCMonth(to.getUTCMonth() + months);
      fromStr = fmtUTC(from.getTime());
      toStr = fmtUTC(to.getTime() - 86400000);
    }

    const { bookedNights, blockedDates } = await store.availability(fromStr, toStr);
    res.status(200).json({
      from: fromStr,
      to: toStr,
      today,
      booked: [...bookedNights].sort(),
      blocked: [...blockedDates].sort(),
      paymentsEnabled: process.env.BOOKING_PAYMENTS_ENABLED === 'true' && !!process.env.STRIPE_SECRET_KEY,
    });
  } catch (err) {
    if (err.code === 'not_configured') {
      res.status(503).json({
        error: 'not_configured',
        booked: [],
        blocked: [],
        today: tokyoToday(),
        paymentsEnabled: false,
      });
      return;
    }
    console.error('availability error:', err);
    res.status(500).json({ error: 'internal error' });
  }
}
