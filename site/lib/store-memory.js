// 開発・テスト用メモリストア。直列化ミューテックスで同時作成を排他する。
// 本番（Vercel）では使用しない（store.js が VERCEL 環境で拒否する）。
import { newBookingId } from './util.js';
import { eachNight } from './util.js';

export function createMemoryStore() {
  const bookings = [];   // 予約レコード
  const blocked = [];    // {date:'YYYY-MM-DD', reason}
  const emails = [];     // {booking_id, kind, status, detail, created_at}
  const adminLogs = [];
  let settings = { cancellationPolicyText: '' };
  const adminUsers = new Map();
  let mutex = Promise.resolve();

  function lock(fn) {
    const run = mutex.then(fn);
    mutex = run.catch(() => {});
    return run;
  }

  /* 支払い猶予: expires_at を過ぎても15分は空きにせず、Webhookでの確定も許す（Issue #9） */
  const PAYMENT_GRACE_MS = 15 * 60 * 1000;

  function active(b) {
    if (b.status === 'confirmed') return true;
    if (b.status === 'pending_payment' || b.status === 'expired') {
      if (!b.expires_at) return b.status === 'pending_payment';
      return b.expires_at + PAYMENT_GRACE_MS > Date.now();
    }
    return false;
  }

  function nightSet(list) {
    const s = new Set();
    for (const b of list) for (const n of (b.nightsList || [])) s.add(n);
    return s;
  }

  const store = {
    kind: 'memory',

    /* pending予約の作成。重複期間があれば {code:'unavailable'} を throw */
    async createPendingBooking(rec) {
      return lock(() => {
        if (store._findActive(rec.checkin, rec.checkout)) {
          const e = new Error('指定の日程は予約できません');
          e.code = 'unavailable';
          throw e;
        }
        const b = {
          id: newBookingId(),
          request_id: rec.request_id || null,
          checkin: rec.checkin,
          checkout: rec.checkout,
          nights: rec.nights,
          nightsList: eachNight(rec.checkin, rec.checkout),
          adults: rec.adults,
          infants: rec.infants || 0,
          payment_method: rec.payment_method || 'online',
          options_online: rec.options_online || 0,
          options_onsite: rec.options_onsite || 0,
          online_total: rec.online_total || 0,
          onsite_amount: rec.onsite_amount || 0,
          refund_id: null,
          refund_amount: null,
          thankyou_sent: 'pending',
          guest_name: rec.guest_name,
          guest_kana: rec.guest_kana || '',
          guest_email: rec.guest_email,
          guest_phone: rec.guest_phone,
          guest_address: rec.guest_address || '',
          arrival_time: rec.arrival_time || '',
          notes: rec.notes || '',
          options: rec.options || {},
          price_jpy: rec.price_jpy,
          price_detail: rec.price_detail || {},
          status: 'pending_payment',
          stripe_session_id: null,
          payment_intent_id: null,
          email_status: 'pending',
          admin_memo: '',
          source: rec.source || 'web',
          created_at: Date.now(),
          updated_at: Date.now(),
          expires_at: Date.now() + 30 * 60 * 1000,
        };
        bookings.push(b);
        return { ...b };
      });
    },

    async findActive(checkin, checkout) {
      const found = store._findActive(checkin, checkout);
      return found ? found.id : null;
    },

    /* 同一連絡先の未完了仮予約。いたずら連打で全日程を押さえられるのを防ぐ（Issue #11） */
    findActivePendingByContact(email, phone) {
      const hit = bookings.find((b) => b.status === 'pending_payment'
        && (b.expires_at === null || b.expires_at > Date.now() - 15 * 60 * 1000)
        && (b.guest_email === email || b.guest_phone === phone));
      return hit ? { id: hit.id, checkin: hit.checkin, checkout: hit.checkout } : null;
    },

    _findActive(checkin, checkout) {
      const nights = eachNight(checkin, checkout);
      const hit = bookings.find((b) => active(b) && (b.nightsList || []).some((n) => nights.includes(n)));
      return hit || null;
    },

    async getBooking(id) {
      const b = bookings.find((x) => x.id === id);
      return b ? { ...b } : null;
    },

    async getBookingByRequest(requestId) {
      const b = bookings.find((x) => x.request_id === requestId);
      return b ? { ...b } : null;
    },

    async listBookings(filter = {}) {
      let list = bookings.slice().sort((a, b) => b.created_at - a.created_at);
      if (filter.status) list = list.filter((b) => b.status === filter.status);
      if (filter.q) {
        const q = String(filter.q).toLowerCase();
        list = list.filter((b) =>
          [b.id, b.guest_name, b.guest_email, b.guest_phone].some((v) => String(v || '').toLowerCase().includes(q)));
      }
      return list.map((b) => ({ ...b }));
    },

    /* 冪等な確定遷移。pending_payment からのみ confirmed へ。変更があれば changed=true */
    async confirmBooking(id, paymentIntentId) {
      return lock(() => {
        const b = bookings.find((x) => x.id === id);
        if (!b) { const e = new Error('not found'); e.code = 'not_found'; throw e; }
        if (b.status === 'confirmed') return { booking: { ...b }, changed: false };
        const withinGrace = b.expires_at && b.expires_at + PAYMENT_GRACE_MS > Date.now();
        if (b.status !== 'pending_payment' && !(b.status === 'expired' && withinGrace)) {
          const e = new Error('invalid status: ' + b.status);
          e.code = 'invalid_status';
          throw e;
        }
        b.status = 'confirmed';
        b.confirmed_at = Date.now();
        b.payment_intent_id = paymentIntentId || b.payment_intent_id;
        b.expires_at = null;
        b.updated_at = Date.now();
        return { booking: { ...b }, changed: true };
      });
    },

    async setBookingStatus(id, status, _extra = null) {
      return lock(() => {
        const b = bookings.find((x) => x.id === id);
        if (!b) { const e = new Error('not found'); e.code = 'not_found'; throw e; }
        b.status = status;
        b.updated_at = Date.now();
        return { ...b };
      });
    },

    async setStripeSession(id, sessionId) {
      const b = bookings.find((x) => x.id === id);
      if (b) b.stripe_session_id = sessionId;
    },

    /* confirmed からのみ遷移させる条件付き更新（二重返金防止の排他点） */
    async updateBookingIfConfirmed(id, patch) {
      return lock(() => {
        const b = bookings.find((x) => x.id === id);
        if (!b || b.status !== 'confirmed') return null;
        b.status = patch.status || b.status;
        if (patch.refund_amount != null) b.refund_amount = patch.refund_amount;
        b.updated_at = Date.now();
        return { ...b };
      });
    },

    /* 入金記録: confirmed のみ・冪等。メモは書き換えない（Issue #10） */
    async markBookingPaid(id) {
      return lock(() => {
        const b = bookings.find((x) => x.id === id);
        if (!b || b.status !== 'confirmed' || b.paid_at) return null;
        b.paid_at = Date.now();
        b.updated_at = Date.now();
        return { ...b };
      });
    },

    /* 入金記録の取り消し: 記録があれば状態を問わず外せる（Issue #10） */
    async unmarkBookingPaid(id) {
      return lock(() => {
        const b = bookings.find((x) => x.id === id);
        if (!b || !b.paid_at) return null;
        b.paid_at = null;
        b.updated_at = Date.now();
        return { ...b };
      });
    },

    async updateBooking(id, patch) {
      return lock(() => {
        const b = bookings.find((x) => x.id === id);
        if (!b) { const e = new Error('not found'); e.code = 'not_found'; throw e; }
        Object.assign(b, patch, { updated_at: Date.now() });
        return { ...b };
      });
    },

    /* 期限切れ pending を expired へ。解放された予約ID配列を返す */
    async expireStale(now = Date.now()) {
      return lock(() => {
        const released = [];
        for (const b of bookings) {
          if (b.status === 'pending_payment' && b.expires_at && b.expires_at < now) {
            b.status = 'expired';
            b.updated_at = Date.now();
            released.push(b.id);
          }
        }
        return released;
      });
    },

    /* 指定期間の宿泊夜（アクティブ予約）とブロック日を返す */
    async availability(checkin, checkout) {
      const act = bookings.filter(active);
      return {
        bookedNights: nightSet(act),
        blockedDates: new Set(blocked.map((x) => x.date)),
      };
    },

    async listBlocked() { return blocked.map((x) => ({ ...x })); },

    async addBlockedRange(from, to, reason) {
      return lock(() => {
        const a = new Date(from + 'T00:00:00Z');
        const b = new Date(to + 'T00:00:00Z');
        for (let t = a.getTime(); t <= b.getTime(); t += 86400000) {
          const d = new Date(t).toISOString().slice(0, 10);
          if (!blocked.some((x) => x.date === d)) blocked.push({ date: d, reason: reason || '' });
        }
        return true;
      });
    },

    async removeBlockedRange(from, to) {
      return lock(() => {
        const a = new Date(from + 'T00:00:00Z');
        const b = new Date(to + 'T00:00:00Z');
        for (let t = a.getTime(); t <= b.getTime(); t += 86400000) {
          const d = new Date(t).toISOString().slice(0, 10);
          const i = blocked.findIndex((x) => x.date === d);
          if (i >= 0) blocked.splice(i, 1);
        }
        return true;
      });
    },

    async getSettings() { return { ...settings }; },

    async saveSettings(patch) {
      settings = { ...settings, ...patch };
      return { ...settings };
    },

    async logEmail(rec) {
      emails.push({ booking_id: rec.booking_id, kind: rec.kind, status: rec.status, detail: rec.detail || '', created_at: Date.now() });
    },

    async emailFailCount(bookingId) {
      return emails.filter((e) => e.booking_id === bookingId && e.status === 'failed').length;
    },

    async ensureAdminUsers(entries) {
      return lock(() => {
        for (const e of entries) {
          if (!adminUsers.has(e.username)) {
            adminUsers.set(e.username, { username: e.username, name: e.name, passHash: e.passHash });
          }
        }
        return true;
      });
    },

    async getAdminUser(username) {
      const u = adminUsers.get(username);
      return u ? { ...u, disabled: !!u.disabled } : null;
    },

    async updateAdminPassword(username, passHash) {
      adminUsers.set(username, { ...adminUsers.get(username), passHash });
      return true;
    },

    async setAdminDisabled(username, disabled) {
      const u = adminUsers.get(username);
      if (u) { u.disabled = disabled; }
      return true;
    },

    async listAdmins() {
      return [...adminUsers.values()].map((u) => ({ username: u.username, name: u.name, disabled: !!u.disabled }));
    },

    async logAdmin(action, detail) {
      adminLogs.push({ action, detail: detail || null, created_at: Date.now() });
    },

    async listAdminLogs(limit = 100) {
      return adminLogs.slice(-limit).reverse();
    },

    /* 15分以内のログイン失敗回数（Issue #14） */
    async countRecentLoginFailures(username) {
      const windowStart = Date.now() - 15 * 60 * 1000;
      return adminLogs.filter((l) => l.action === 'login_failed'
        && l.detail && l.detail.username === username
        && l.created_at > windowStart).length;
    },
  };
  return store;
}
