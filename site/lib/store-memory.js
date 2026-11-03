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
  let mutex = Promise.resolve();

  function lock(fn) {
    const run = mutex.then(fn);
    mutex = run.catch(() => {});
    return run;
  }

  function active(b) {
    return (b.status === 'confirmed' || b.status === 'pending_payment') &&
      !(b.status === 'pending_payment' && b.expires_at && b.expires_at <= Date.now());
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
          children: rec.children || 0,
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
        if (b.status !== 'pending_payment') {
          const e = new Error('invalid status: ' + b.status);
          e.code = 'invalid_status';
          throw e;
        }
        b.status = 'confirmed';
        b.payment_intent_id = paymentIntentId || b.payment_intent_id;
        b.expires_at = null;
        b.updated_at = Date.now();
        return { booking: { ...b }, changed: true };
      });
    },

    async setBookingStatus(id, status, extra = {}) {
      return lock(() => {
        const b = bookings.find((x) => x.id === id);
        if (!b) { const e = new Error('not found'); e.code = 'not_found'; throw e; }
        b.status = status;
        if (extra.paymentIntentId) b.payment_intent_id = extra.paymentIntentId;
        if (extra.memo != null) b.admin_memo = String(extra.memo).slice(0, 2000);
        b.updated_at = Date.now();
        return { ...b };
      });
    },

    async setStripeSession(id, sessionId) {
      const b = bookings.find((x) => x.id === id);
      if (b) b.stripe_session_id = sessionId;
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

    async logAdmin(action, detail) {
      adminLogs.push({ action, detail: detail || null, created_at: Date.now() });
    },

    async listAdminLogs(limit = 100) {
      return adminLogs.slice(-limit).reverse();
    },
  };
  return store;
}
