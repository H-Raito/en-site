// 運営者向け管理API（単一ルーター）。認証: x-admin-key ヘッダ or en_admin クッキー。
import { getStore } from '../lib/store.js';
import { isAdmin, checkAdminKey, issueToken } from '../lib/admin-auth.js';
import { confirmAndNotify } from '../lib/confirm.js';
import { computePrice, validateBookingInput, PRICING } from '../lib/pricing.js';
import { tokyoToday, parseDate, isValidEmail, isValidPhone, capStr } from '../lib/util.js';

export default async function handler(req, res) {
  const q = new URLSearchParams((req.url.split('?')[1]) || '');
  const action = (req.body && req.body.action) || q.get('action') || '';

  if (action === 'login') {
    if (!checkAdminKey((req.body && req.body.key) || q.get('key'))) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const token = issueToken();
    res.setHeader('Set-Cookie', 'en_admin=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800');
    res.status(200).json({ ok: true });
    return;
  }

  if (!isAdmin(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!process.env.ADMIN_KEY) {
    res.status(503).json({ error: 'admin not configured' });
    return;
  }

  let store;
  try {
    store = await getStore();
  } catch (err) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }
  await store.expireStale();

  try {
    switch (action) {
      case 'bookings.list': {
        const list = await store.listBookings({ status: q.get('status') || '', q: q.get('q') || '' });
        res.status(200).json({ bookings: list });
        return;
      }
      case 'booking.get': {
        const b = await store.getBooking(q.get('id') || '');
        if (!b) { res.status(404).json({ error: 'not_found' }); return; }
        res.status(200).json({ booking: b });
        return;
      }
      case 'booking.cancel': {
        const id = q.get('id') || '';
        const b = await store.getBooking(id);
        if (!b) { res.status(404).json({ error: 'not_found' }); return; }
        if (b.status === 'cancelled') { res.status(200).json({ booking: b, already: true }); return; }
        await store.setBookingStatus(id, 'cancelled', { memo: '管理操作によるキャンセル' });
        await store.logAdmin('booking_cancel', { id });
        res.status(200).json({ ok: true });
        return;
      }
      case 'booking.refund': {
        const id = q.get('id') || '';
        const b = await store.getBooking(id);
        if (!b || !b.stripe_session_id) { res.status(404).json({ error: 'not_found' }); return; }
        if (b.status !== 'confirmed') { res.status(400).json({ error: 'invalid status: ' + b.status }); return; }
        const { default: Stripe } = await import('stripe');
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const s = await stripe.checkout.sessions.retrieve(b.stripe_session_id);
        const pi = s.payment_intent;
        if (!pi) { res.status(400).json({ error: 'no payment_intent' }); return; }
        const refund = await stripe.refunds.create({ payment_intent: pi });
        await store.setBookingStatus(id, 'refunded', { memo: 'Stripe返金実行' });
        await store.logAdmin('booking_refund', { id, refund_id: refund.id });
        res.status(200).json({ ok: true, refund_id: refund.id });
        return;
      }
      case 'booking.resend-emails': {
        const id = q.get('id') || '';
        const b = await store.getBooking(id);
        if (!b || b.status !== 'confirmed') { res.status(400).json({ error: 'invalid booking' }); return; }
        const results = await confirmResendSafe(b);
        const okAll = results.customer.ok && results.owner.ok;
        await store.updateBooking(id, { email_status: okAll ? 'sent' : 'failed' });
        await store.logEmail({ booking_id: id, kind: 'admin-resend', status: okAll ? 'sent' : 'failed', detail: String(results.customer.errorText || '') });
        res.status(200).json({ ok: okAll, detail: results });
        return;
      }
      case 'booking.memo': {
        const id = q.get('id') || '';
        const body = await readBody(req);
        const b = await store.updateBooking(id, { admin_memo: capStr((body && body.memo) || '', 2000) });
        await store.logAdmin('booking_memo', { id });
        res.status(200).json({ ok: true });
        return;
      }
      case 'booking.manual': {
        const body = await readBody(req);
        const v = validateBookingInput({
          checkin: body.checkin, checkout: body.checkout,
          adults: parseInt(body.adults, 10), children: body.children == null ? 0 : parseInt(body.children, 10),
        }, tokyoToday());
        if (!v.ok) { res.status(400).json({ error: v.error }); return; }
        if (!body.name || !isValidEmail(body.email || '') || !isValidPhone(body.phone || '')) {
          res.status(400).json({ error: 'invalid guest info' });
          return;
        }
        const price = computePrice(v.adults, v.nights);
        const rec = await store.createPendingBooking({
          checkin: body.checkin, checkout: body.checkout,
          nights: v.nights, adults: v.adults, children: v.children,
          guest_name: capStr(body.name, 60), guest_email: capStr(body.email, 120),
          guest_phone: capStr(body.phone, 20), guest_address: capStr(body.address || '', 120),
          arrival_time: capStr(body.arrival || '', 10), notes: capStr(body.notes || '', 500),
          options: { bbq: !!body.bbq, sauna: !!body.sauna },
          price_jpy: price.total, price_detail: price,
          source: 'manual',
        });
        /* 手動登録は即時確定（決済なし・電話精算運用） */
        await store.confirmBooking(rec.id, null);
        await store.setBookingStatus(rec.id, 'confirmed', { memo: '管理画面からの手動登録' });
        await store.logAdmin('booking_manual', { id: rec.id });
        res.status(200).json({ booking: await store.getBooking(rec.id) });
        return;
      }
      case 'blocked.list': {
        res.status(200).json({ blocked: await store.listBlocked() });
        return;
      }
      case 'blocked.add': {
        const body = await readBody(req);
        const from = body.from, to = body.to || body.from;
        if (!parseDate(from) || !parseDate(to) || from > to) { res.status(400).json({ error: 'invalid dates' }); return; }
        await store.addBlockedRange(from, to, capStr(body.reason || '', 100));
        await store.logAdmin('blocked_add', { from, to, reason: body.reason || '' });
        res.status(200).json({ ok: true });
        return;
      }
      case 'blocked.remove': {
        const body = await readBody(req);
        const from = body.from, to = body.to || body.from;
        if (!parseDate(from) || !parseDate(to) || from > to) { res.status(400).json({ error: 'invalid dates' }); return; }
        await store.removeBlockedRange(from, to);
        await store.logAdmin('blocked_remove', { from, to });
        res.status(200).json({ ok: true });
        return;
      }
      case 'calendar': {
        const year = parseInt(q.get('year'), 10) || new Date().getFullYear();
        const list = await store.listBookings({});
        const blocked = await store.listBlocked();
        res.status(200).json({ year, bookings: list, blocked });
        return;
      }
      case 'settings.get': {
        res.status(200).json({ settings: await store.getSettings() });
        return;
      }
      case 'settings.save': {
        const body = await readBody(req);
        await store.saveSettings({ cancellationPolicyText: capStr((body && body.cancellationPolicyText) || '', 2000) });
        await store.logAdmin('settings_save', {});
        res.status(200).json({ ok: true });
        return;
      }
      case 'logs': {
        res.status(200).json({ logs: await store.listAdminLogs(100) });
        return;
      }
      default:
        res.status(400).json({ error: 'unknown action' });
    }
  } catch (err) {
    if (err.code === 'unavailable') { res.status(409).json({ error: 'unavailable' }); return; }
    console.error('admin error:', err);
    res.status(500).json({ error: 'internal error' });
  }
}

async function confirmResendSafe(b) {
  try {
    return await sendBookingEmails(b);
  } catch (e) {
    return { customer: { ok: false, errorText: String(e) }, owner: { ok: false, errorText: '' } };
  }
}

import { sendBookingEmails } from '../lib/email.js';

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
