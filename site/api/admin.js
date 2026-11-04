// 運営者向け管理API（単一ルーター）。
// 認証: 管理者アカウント（ユーザー名+パスワード・scrypt・ADMIN_SEED環境変数からシード）
// →HMAC署名クッキー（8時間）。変更系POSTは x-requested-with ヘッダ必須（CSRF対策）。
// ログイン試行制限: ユーザー名あたり5回/15分。
import { getStore } from '../lib/store.js';
import {
  adminEnabled, isAdmin, issueToken, csrfOk,
  loginBlocked, recordLoginFailure, clearLoginFailures,
  adminSeedEntries, hashPassword, verifyPassword,
} from '../lib/admin-auth.js';
import { sendBookingEmails } from '../lib/email.js';
import { computePrice, validateBookingInput, calculateRefund } from '../lib/pricing.js';
import { tokyoToday, parseDate, isValidEmail, isValidPhone, capStr } from '../lib/util.js';

function json(res, code, obj) {
  res.status(code).json(obj);
}

export default async function handler(req, res) {
  const q = new URLSearchParams((req.url.split('?')[1]) || '');
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  const action = (body && body.action) || q.get('action') || '';

  /* ---- ログイン ---- */
  if (action === 'login') {
    if (!adminEnabled()) {
      json(res, 503, { error: 'admin_not_configured' });
      return;
    }
    const username = capStr(String((body && body.username) || q.get('username') || ''), 40);
    const password = String((body && body.password) || q.get('password') || '');
    if (!username || !password) {
      json(res, 400, { error: 'invalid input' });
      return;
    }
    if (loginBlocked(username)) {
      json(res, 429, { error: 'too_many_attempts' });
      return;
    }
    /* ADMIN_SEED の設定状態を事前検証（形式ミス・未設定を明示する） */
    if (!process.env.ADMIN_SEED) {
      json(res, 503, { error: 'seed_missing' });
      return;
    }
    if (adminSeedEntries().length === 0) {
      json(res, 503, { error: 'seed_invalid' });
      return;
    }
    try {
      const store = await getStore();
      await store.ensureAdminUsers(
        adminSeedEntries().map(function (e) {
          return { username: e.username, name: e.name, passHash: hashPassword(e.password) };
        })
      );
      const user = await store.getAdminUser(username);
      if (!user || !verifyPassword(password, user.passHash)) {
        recordLoginFailure(username);
        await store.logAdmin('login_failed', { username });
        json(res, 401, { error: 'invalid_credentials' });
        return;
      }
      clearLoginFailures(username);
      json(res, 200, { ok: true, username: user.username, name: user.name });
      await store.logAdmin('login_success', { username });
      const token = issueToken(username);
      res.setHeader('Set-Cookie', 'en_admin=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800');
    } catch (err) {
      if (err.code === 'not_configured') {
        json(res, 503, { error: 'not_configured' });
        return;
      }
      /* セットアップ中のDBエラーは原因を画面に見せる（本番運用時は削除可） */
      console.error('login db error:', err);
      json(res, 502, { error: 'db_setup_failed', detail: String(err.message || err).slice(0, 160) });
      return;
    }
    return;
  }

  /* ---- 認証 ---- */
  const username = isAdmin(req);
  if (!username) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  /* ---- CSRF: 変更系POSTはカスタムヘッダ必須 ---- */
  if (req.method === 'POST' && !csrfOk(req)) {
    json(res, 403, { error: 'csrf' });
    return;
  }

  let store;
  try {
    store = await getStore();
  } catch (err) {
    json(res, 503, { error: 'not_configured' });
    return;
  }
  await store.expireStale();

  try {
    await routeAction(action, req, res, q, body, username, store);
  } catch (err) {
    if (err.code === 'unavailable') {
      json(res, 409, { error: 'unavailable' });
      return;
    }
    console.error('admin error:', err);
    json(res, 500, { error: 'internal error' });
  }
}

async function routeAction(action, req, res, q, body, username, store) {
  switch (action) {
    case 'bookings.list': {
      const list = await store.listBookings({ status: q.get('status') || '', q: q.get('q') || '' });
      json(res, 200, { bookings: list });
      return;
    }
    case 'booking.get': {
      const b = await store.getBooking(q.get('id') || '');
      if (!b) { json(res, 404, { error: 'not_found' }); return; }
      json(res, 200, { booking: b });
      return;
    }
    case 'booking.cancel': {
      const id = q.get('id') || '';
      const b = await store.getBooking(id);
      if (!b) { json(res, 404, { error: 'not_found' }); return; }
      if (b.status === 'cancelled') { json(res, 200, { booking: b, already: true }); return; }
      await store.setBookingStatus(id, 'cancelled', { memo: '管理キャンセル(' + username + ')' });
      await store.logAdmin('booking_cancel', { id, by: username });
      json(res, 200, { ok: true });
      return;
    }
    case 'booking.refund': {
      const id = q.get('id') || '';
      const b = await store.getBooking(id);
      if (!b) { json(res, 404, { error: 'not_found' }); return; }
      if (b.status !== 'confirmed') {
        json(res, 400, { error: 'invalid status: ' + b.status + '（返金は確定予約のみ）' });
        return;
      }
      /* ポリシーに基づく返金額をサーバー計算。二重返金防止のため状態を先に専有する。 */
      const calc = calculateRefund(b, Date.now());
      const refundAmount = calc.refundJpy + calc.optionsRefundJpy;
      const reserved = await store.updateBookingIfConfirmed(id, {
        status: 'refunded',
        refund_amount: refundAmount,
        admin_memo: '返金実行(' + username + ') 区分=' + calc.tier,
      });
      if (!reserved) {
        json(res, 409, { error: 'already_processed' });
        return;
      }
      try {
        let refundId = null;
        if (refundAmount > 0) {
          const { default: Stripe } = await import('stripe');
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          const s = await stripe.checkout.sessions.retrieve(b.stripe_session_id);
          if (!s.payment_intent) throw new Error('no payment_intent');
          const refund = await stripe.refunds.create(
            s.payment_intent,
            { amount: refundAmount },
            { idempotency_key: 'en_refund_' + b.id }
          );
          refundId = refund.id;
        }
        await store.updateBooking(id, { refund_id: refundId });
        await store.logAdmin('booking_refund', { id, amount: refundAmount, tier: calc.tier, by: username });
        json(res, 200, { ok: true, refund_id: refundId, amount: refundAmount, tier: calc.tier });
      } catch (e) {
        /* 返金失敗時は返金済みと表示しない: 状態を confirmed に復帰 */
        await store.setBookingStatus(id, 'confirmed', { memo: '返金失敗のため状態を復帰' });
        console.error('refund error:', e);
        json(res, 502, { error: 'refund_failed', detail: String(e.message || e).slice(0, 200) });
      }
      return;
    }
    case 'booking.resend-emails': {
      const id = q.get('id') || '';
      const b = await store.getBooking(id);
      if (!b || b.status !== 'confirmed') { json(res, 400, { error: 'invalid booking' }); return; }
      const results = await sendBookingEmails(b);
      const okAll = results.customer.ok && results.owner.ok;
      await store.updateBooking(id, { email_status: okAll ? 'sent' : 'failed' });
      await store.logEmail({ booking_id: id, kind: 'admin-resend', status: okAll ? 'sent' : 'failed', detail: String(results.customer.errorText || '') });
      json(res, 200, { ok: okAll });
      return;
    }
    case 'booking.memo': {
      const id = (body && body.id) || q.get('id') || '';
      await store.updateBooking(id, { admin_memo: capStr((body && body.memo) || '', 2000) });
      await store.logAdmin('booking_memo', { id, by: username });
      json(res, 200, { ok: true });
      return;
    }
    case 'booking.manual': {
      const v = validateBookingInput({
        checkin: body.checkin, checkout: body.checkout,
        adults: parseInt(body.adults, 10), infants: body.infants == null ? 0 : parseInt(body.infants, 10),
      }, tokyoToday(), Date.now());
      if (!v.ok) { json(res, 400, { error: v.error }); return; }
      if (!body.name || !isValidEmail(body.email || '') || !isValidPhone(body.phone || '')) {
        json(res, 400, { error: 'invalid guest info' });
        return;
      }
      const price = computePrice(v.adults, v.nights, {}, 'onsite');
      const rec = await store.createPendingBooking({
        checkin: body.checkin, checkout: body.checkout,
        nights: v.nights, adults: v.adults, infants: v.infants,
        guest_name: capStr(body.name, 60), guest_email: capStr(body.email, 120),
        guest_phone: capStr(body.phone, 20), guest_address: capStr(body.address || '', 120),
        arrival_time: capStr(body.arrival || '', 10), notes: capStr(body.notes || '', 500),
        options: { bbq: !!body.bbq, sauna: !!body.sauna, earlyCheckin: !!body.earlyCheckin },
        payment_method: 'manual',
        options_online: 0, options_onsite: price.onlineTotal,
        online_total: 0, onsite_amount: price.onlineTotal,
        price_jpy: price.onlineTotal,
        price_detail: { ...price, adults: v.adults, nights: v.nights },
        source: 'manual',
      });
      await store.confirmBooking(rec.id, null);
      await store.setBookingStatus(rec.id, 'confirmed', { memo: '管理画面からの手動登録(' + username + ')・現地精算' });
      await store.logAdmin('booking_manual', { id: rec.id, by: username });
      json(res, 200, { booking: await store.getBooking(rec.id) });
      return;
    }
    case 'blocked.list': {
      json(res, 200, { blocked: await store.listBlocked() });
      return;
    }
    case 'blocked.add': {
      const from = body.from, to = body.to || body.from;
      if (!parseDate(from) || !parseDate(to) || from > to) { json(res, 400, { error: 'invalid dates' }); return; }
      await store.addBlockedRange(from, to, capStr(body.reason || '', 100));
      await store.logAdmin('blocked_add', { from, to, reason: body.reason || '', by: username });
      json(res, 200, { ok: true });
      return;
    }
    case 'blocked.remove': {
      const from = body.from, to = body.to || body.from;
      if (!parseDate(from) || !parseDate(to) || from > to) { json(res, 400, { error: 'invalid dates' }); return; }
      await store.removeBlockedRange(from, to);
      await store.logAdmin('blocked_remove', { from, to, by: username });
      json(res, 200, { ok: true });
      return;
    }
    case 'calendar': {
      const year = parseInt(q.get('year'), 10) || new Date().getFullYear();
      json(res, 200, { year, bookings: await store.listBookings({}), blocked: await store.listBlocked() });
      return;
    }
    case 'settings.get': {
      json(res, 200, { settings: await store.getSettings() });
      return;
    }
    case 'settings.save': {
      await store.saveSettings({ cancellationPolicyText: capStr((body && body.cancellationPolicyText) || '', 2000) });
      await store.logAdmin('settings_save', { by: username });
      json(res, 200, { ok: true });
      return;
    }
    case 'logs': {
      json(res, 200, { logs: await store.listAdminLogs(100) });
      return;
    }
    case 'analytics': {
      const year = parseInt(q.get('year'), 10) || new Date().getFullYear();
      const list = await store.listBookings({});
      const months = [];
      for (let m = 1; m <= 12; m++) {
        months.push({ month: m, onlineRevenue: 0, onsiteDue: 0, bookings: 0, cancellations: 0, refunded: 0, guests: 0, nights: 0, manual: 0 });
      }
      let optionBbq = 0, optionSauna = 0, optionEarly = 0;
      for (const b of list) {
        const ci = String(b.checkin || '');
        if (ci.slice(0, 4) !== String(year)) continue;
        const m = parseInt(ci.slice(5, 7), 10);
        if (!(m >= 1 && m <= 12)) continue;
        const slot = months[m - 1];
        if (b.status === 'confirmed') {
          slot.bookings++;
          slot.nights += b.nights || 0;
          slot.guests += b.adults || 0;
          if (b.source === 'manual') {
            slot.manual++;
            slot.onsiteDue += b.onsite_amount || 0;
          } else {
            slot.onlineRevenue += b.online_total || b.price_jpy || 0;
            slot.onsiteDue += b.onsite_amount || 0;
          }
        } else if (b.status === 'cancelled') {
          slot.cancellations++;
        } else if (b.status === 'refunded') {
          slot.refunded++;
        }
        if (b.options && b.options.bbq) optionBbq++;
        if (b.options && b.options.sauna) optionSauna++;
        if (b.options && b.options.earlyCheckin) optionEarly++;
      }
      /* 稼働率: 宿泊夜数 / 日数 */
      for (const slot of months) {
        const days = new Date(year, slot.month, 0).getDate();
        slot.occupancy = Math.round((slot.nights / days) * 1000) / 10;
      }
      json(res, 200, {
        year,
        months,
        totals: {
          onlineRevenue: months.reduce((a, x) => a + x.onlineRevenue, 0),
          onsiteDue: months.reduce((a, x) => a + x.onsiteDue, 0),
          bookings: months.reduce((a, x) => a + x.bookings, 0),
          cancellations: months.reduce((a, x) => a + x.cancellations, 0),
          refunded: months.reduce((a, x) => a + x.refunded, 0),
          manual: months.reduce((a, x) => a + x.manual, 0),
          nights: months.reduce((a, x) => a + x.nights, 0),
          avgGuests: (function () {
            const withGuests = months.filter((x) => x.bookings > 0);
            if (!withGuests.length) return 0;
            return Math.round((withGuests.reduce((a, x) => a + x.guests, 0) / withGuests.reduce((a, x) => a + x.bookings, 0)) * 10) / 10;
          })(),
        },
        options: { bbq: optionBbq, sauna: optionSauna, earlyCheckin: optionEarly },
      });
      return;
    }
    default:
      json(res, 400, { error: 'unknown action' });
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
