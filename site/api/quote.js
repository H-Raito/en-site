// サーバー側料金見積り。表示金額と決済金額の一致を保証する唯一の計算経路。
import { getStore } from '../lib/store.js';
import { tokyoToday } from '../lib/util.js';
import { computePrice, validateBookingInput } from '../lib/pricing.js';

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
  const v = validateBookingInput({
    checkin: body.checkin,
    checkout: body.checkout,
    adults: parseInt(body.adults, 10),
    infants: body.infants == null ? 0 : parseInt(body.infants, 10),
    paymentMethod: body.paymentMethod,
  }, tokyoToday());
  if (!v.ok) {
    res.status(400).json({ error: v.error });
    return;
  }
  try {
    const store = await getStore();
    await store.expireStale();
    const hit = await store.findActive(body.checkin, body.checkout);
    if (hit) {
      res.status(409).json({ error: 'unavailable' });
      return;
    }
    const p = computePrice(v.adults, v.nights, {
      bbq: !!body.bbq, sauna: !!body.sauna, earlyCheckin: !!body.earlyCheckin,
    }, body.paymentMethod === 'onsite' ? 'onsite' : 'online');
    res.status(200).json({
      nights: v.nights, adults: v.adults, infants: v.infants,
      perNight: p.perNight, subtotal: p.staySubtotal,
      optionsOnline: p.optionsOnline, optionsOnsite: p.optionsOnsite,
      onlineTotal: p.onlineTotal, onsiteAmount: p.onsiteAmount,
      taxIncluded: true,
    });
  } catch (err) {
    if (err.code === 'not_configured') {
      const p = computePrice(v.adults, v.nights, {}, 'online');
      res.status(200).json({
        nights: v.nights, adults: v.adults, infants: v.infants,
        perNight: p.perNight, subtotal: p.staySubtotal,
        optionsOnline: 0, optionsOnsite: 0, onlineTotal: p.onlineTotal, onsiteAmount: 0,
        taxIncluded: true, unavailableCheck: 'skipped',
      });
      return;
    }
    console.error('quote error:', err);
    res.status(500).json({ error: 'internal error' });
  }
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
