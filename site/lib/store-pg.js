// 本番用 Postgres ストア（Neon serverless driver・HTTP経由でVercel Functionsから利用）。
// 二重予約防止はトランザクション内の行ロック（FOR UPDATE）+ 半開区間オーバーラップ照合で行う。
import { eachNight } from './util.js';
import { newBookingId } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  request_id TEXT UNIQUE,
  checkin DATE NOT NULL,
  checkout DATE NOT NULL,
  nights INT NOT NULL,
  adults INT NOT NULL,
  infants INT NOT NULL DEFAULT 0,
  payment_method TEXT DEFAULT 'online',
  options_online INT DEFAULT 0,
  options_onsite INT DEFAULT 0,
  online_total INT DEFAULT 0,
  onsite_amount INT DEFAULT 0,
  refund_id TEXT,
  refund_amount INT,
  thankyou_sent TEXT DEFAULT 'pending',
  guest_name TEXT NOT NULL,
  guest_kana TEXT DEFAULT '',
  guest_email TEXT NOT NULL,
  guest_phone TEXT NOT NULL,
  guest_address TEXT DEFAULT '',
  arrival_time TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  options JSONB NOT NULL DEFAULT '{}'::jsonb,
  price_jpy INT NOT NULL,
  price_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending_payment',
  stripe_session_id TEXT,
  payment_intent_id TEXT,
  email_status TEXT NOT NULL DEFAULT 'pending',
  admin_memo TEXT DEFAULT '',
  source TEXT DEFAULT 'web',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bookings_stay ON bookings (checkin, checkout);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);
CREATE TABLE IF NOT EXISTS blocked_dates (
  date DATE PRIMARY KEY,
  reason TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS email_log (
  id SERIAL PRIMARY KEY,
  booking_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_users (
  username TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_log (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export function createPgStore(databaseUrl) {
  let sql = null;
  let ready = null;

  async function db() {
    if (!sql) {
      const mod = await import('@neondatabase/serverless');
      sql = neon(databaseUrl);
    }
    if (!ready) {
      ready = sql(SCHEMA);
      ready.catch(() => { ready = null; });
    }
    await ready;
    return sql;
  }

  const ACTIVE = "(status = 'confirmed' OR (status = 'pending_payment' AND (expires_at IS NULL OR expires_at > now())))";

  function rowToBooking(r) {
    return {
      id: r.id,
      request_id: r.request_id,
      checkin: r.checkin,
      checkout: r.checkout,
      nights: r.nights,
      adults: r.adults,
      infants: r.infants,
      guest_name: r.guest_name,
      guest_kana: r.guest_kana,
      guest_email: r.guest_email,
      guest_phone: r.guest_phone,
      guest_address: r.guest_address,
      arrival_time: r.arrival_time,
      notes: r.notes,
      options: r.options || {},
      price_jpy: r.price_jpy,
      price_detail: r.price_detail || {},
      status: r.status,
      stripe_session_id: r.stripe_session_id,
      payment_intent_id: r.payment_intent_id,
      email_status: r.email_status,
      admin_memo: r.admin_memo,
      source: r.source,
      created_at: r.created_at ? new Date(r.created_at).getTime() : null,
      updated_at: r.updated_at ? new Date(r.updated_at).getTime() : null,
      expires_at: r.expires_at ? new Date(r.expires_at).getTime() : null,
    };
  }

  const store = {
    kind: 'postgres',

    async createPendingBooking(rec) {
      const sql = await db();
      try {
        return await sql.transaction(async (tx) => {
          /* 期間重複のアクティブ予約を行ロックして照合（半開区間: [checkin, checkout)） */
          const overlap = await tx(
            `SELECT id FROM bookings
             WHERE ${ACTIVE}
               AND checkin < $2::date AND checkout > $1::date
             FOR UPDATE`,
            [rec.checkin, rec.checkout]
          );
          if (overlap.length > 0) {
            const e = new Error('指定の日程は予約できません');
            e.code = 'unavailable';
            throw e;
          }
          const blockedRows = await tx(
            `SELECT date FROM blocked_dates WHERE date >= $1::date AND date < $2::date FOR UPDATE`,
            [rec.checkin, rec.checkout]
          );
          if (blockedRows.length > 0) {
            const e = new Error('指定の日程は予約できません');
            e.code = 'unavailable';
            throw e;
          }
          const id = newBookingId();
          const rows = await tx(
            `INSERT INTO bookings
              (id, request_id, checkin, checkout, nights, adults, children,
               guest_name, guest_kana, guest_email, guest_phone, guest_address,
               arrival_time, notes, options, price_jpy, price_detail, payment_method, options_online, options_onsite, online_total, onsite_amount, status, source, expires_at)
             VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18,'pending_payment',$19,$20,$21,$22,$23, now() + interval '30 minutes')
             RETURNING *`,
            [id, rec.request_id || null, rec.checkin, rec.checkout, rec.nights, rec.adults, rec.infants || 0,
              rec.options_online || 0, rec.options_onsite || 0, rec.online_total || 0, rec.onsite_amount || 0,
              rec.guest_name, rec.guest_kana || '', rec.guest_email, rec.guest_phone, rec.guest_address || '',
              rec.arrival_time || '', rec.notes || '', JSON.stringify(rec.options || {}),
              rec.price_jpy, JSON.stringify(rec.price_detail || {}), rec.source || 'web']
          );
          return rowToBooking(rows[0]);
        });
      } catch (err) {
        if (err.code === 'unavailable') throw err;
        /* トランザクション内部のエラーはそのまま */
        throw err;
      }
    },

    async findActive(checkin, checkout) {
      const sql = await db();
      const rows = await sql(
        `SELECT id FROM bookings WHERE ${ACTIVE} AND checkin < $2::date AND checkout > $1::date LIMIT 1`,
        [checkin, checkout]
      );
      return rows.length > 0 ? rows[0].id : null;
    },

    async getBooking(id) {
      const sql = await db();
      const rows = await sql(`SELECT * FROM bookings WHERE id = $1`, [id]);
      return rows[0] ? rowToBooking(rows[0]) : null;
    },

    async getBookingByRequest(requestId) {
      const sql = await db();
      const rows = await sql(`SELECT * FROM bookings WHERE request_id = $1`, [requestId]);
      return rows[0] ? rowToBooking(rows[0]) : null;
    },

    async listBookings(filter = {}) {
      const sql = await db();
      const conds = [];
      const args = [];
      if (filter.status) { args.push(filter.status); conds.push(`status = $${args.length}`); }
      if (filter.q) {
        args.push('%' + filter.q.toLowerCase() + '%');
        const n = args.length;
        conds.push(`(LOWER(id) LIKE $${n} OR LOWER(guest_name) LIKE $${n} OR LOWER(guest_email) LIKE $${n} OR guest_phone LIKE $${n})`);
      }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const rows = await sql(`SELECT * FROM bookings ${where} ORDER BY created_at DESC LIMIT 500`, args);
      return rows.map(rowToBooking);
    },

    async confirmBooking(id, paymentIntentId) {
      const sql = await db();
      const rows = await sql(
        `UPDATE bookings
         SET status='confirmed', payment_intent_id=COALESCE($2, payment_intent_id),
             expires_at=NULL, updated_at=now()
         WHERE id=$1 AND status='pending_payment'
         RETURNING *`,
        [id, paymentIntentId || null]
      );
      if (rows.length > 0) return { booking: rowToBooking(rows[0]), changed: true };
      const cur = await sql(`SELECT * FROM bookings WHERE id=$1`, [id]);
      if (!cur[0]) { const e = new Error('not found'); e.code = 'not_found'; throw e; }
      if (cur[0].status === 'confirmed') return { booking: rowToBooking(cur[0]), changed: false };
      const e = new Error('invalid status: ' + cur[0].status);
      e.code = 'invalid_status';
      throw e;
    },

    async setBookingStatus(id, status, extra = {}) {
      const sql = await db();
      const rows = await sql(
        `UPDATE bookings SET status=$2, admin_memo=COALESCE($3, admin_memo), updated_at=now() WHERE id=$1 RETURNING *`,
        [id, status, extra.memo != null ? String(extra.memo).slice(0, 2000) : null]
      );
      if (!rows[0]) { const e = new Error('not found'); e.code = 'not_found'; throw e; }
      return rowToBooking(rows[0]);
    },

    async setStripeSession(id, sessionId) {
      const sql = await db();
      await sql(`UPDATE bookings SET stripe_session_id=$2, updated_at=now() WHERE id=$1`, [id, sessionId]);
    },

    async updateBookingIfConfirmed(id, patch) {
      const sql = await db();
      const rows = await sql(
        `UPDATE bookings
         SET status = $2, refund_amount = COALESCE($3, refund_amount),
             admin_memo = COALESCE($4, admin_memo), updated_at = now()
         WHERE id = $1 AND status = 'confirmed'
         RETURNING *`,
        [id, patch.status || 'refunded', patch.refund_amount != null ? patch.refund_amount : null,
         patch.admin_memo != null ? patch.admin_memo : null]
      );
      return rows[0] ? rowToBooking(rows[0]) : null;
    },

    async updateBooking(id, patch) {
      const sql = await db();
      const allowed = ['guest_name', 'guest_kana', 'guest_email', 'guest_phone', 'guest_address', 'arrival_time', 'notes', 'admin_memo', 'email_status'];
      const sets = [];
      const args = [id];
      for (const k of allowed) {
        if (patch[k] != null) {
          args.push(patch[k]);
          sets.push(`${k} = $${args.length}`);
        }
      }
      if (!sets.length) return store.getBooking(id);
      args.push(new Date().toISOString());
      sets.push(`updated_at = $${args.length}`);
      const rows = await sql(`UPDATE bookings SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, args);
      return rowToBooking(rows[0]);
    },

    async expireStale(now = Date.now()) {
      const sql = await db();
      const rows = await sql(
        `UPDATE bookings SET status='expired', updated_at=now()
         WHERE status='pending_payment' AND expires_at IS NOT NULL AND expires_at < now()
         RETURNING id`,
        []
      );
      return rows.map((r) => r.id);
    },

    async availability(checkin, checkout) {
      const sql = await db();
      const rows = await sql(
        `SELECT checkin, checkout FROM bookings WHERE ${ACTIVE} AND checkin < $2::date AND checkout > $1::date`,
        [checkin, checkout]
      );
      const bookedNights = new Set();
      for (const r of rows) for (const n of eachNight(r.checkin, r.checkout)) bookedNights.add(n);
      const brows = await sql(`SELECT date FROM blocked_dates WHERE date >= $1::date AND date < $2::date`, [checkin, checkout]);
      const blockedDates = new Set(brows.map((r) => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10))));
      return { bookedNights, blockedDates };
    },

    async listBlocked() {
      const sql = await db();
      const rows = await sql(`SELECT date, reason FROM blocked_dates ORDER BY date`);
      return rows.map((r) => ({ date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10), reason: r.reason || '' }));
    },

    async addBlockedRange(from, to, reason) {
      const sql = await db();
      await sql(
        `INSERT INTO blocked_dates (date, reason)
         SELECT d::date, $3 FROM generate_series($1::date, $2::date, interval '1 day') d
         ON CONFLICT (date) DO NOTHING`,
        [from, to, reason || '']
      );
      return true;
    },

    async removeBlockedRange(from, to) {
      const sql = await db();
      await sql(`DELETE FROM blocked_dates WHERE date BETWEEN $1::date AND $2::date`, [from, to]);
      return true;
    },

    async getSettings() {
      const sql = await db();
      await db();
      const rows = await sql(`SELECT key, value FROM settings`);
      const out = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    },

    async saveSettings(patch) {
      const sql = await db();
      for (const [k, v] of Object.entries(patch)) {
        await sql(
          `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
          [k, JSON.stringify(v)]
        );
      }
      return store.getSettings();
    },

    async logEmail(rec) {
      const sql = await db();
      await sql(`INSERT INTO email_log (booking_id, kind, status, detail) VALUES ($1,$2,$3,$4)`,
        [rec.booking_id, rec.kind, rec.status, rec.detail || '']);
    },

    async emailFailCount(bookingId) {
      const sql = await db();
      const rows = await sql(`SELECT count(*)::int AS c FROM email_log WHERE booking_id=$1 AND status='failed'`, [bookingId]);
      return rows[0].c;
    },

    async logAdmin(action, detail) {
      const sql = await db();
      await sql(`INSERT INTO admin_log (action, detail) VALUES ($1, $2::jsonb)`, [action, detail ? JSON.stringify(detail) : null]);
    },

    async ensureAdminUsers(entries) {
      const sql = await db();
      for (const e of entries) {
        await sql(
          `INSERT INTO admin_users (username, name, pass_hash) VALUES ($1, $2, $3)
           ON CONFLICT (username) DO NOTHING`,
          [e.username, e.name, e.passHash]
        );
      }
      return true;
    },

    async getAdminUser(username) {
      const sql = await db();
      const rows = await sql(`SELECT username, name, pass_hash FROM admin_users WHERE username = $1`, [username]);
      return rows[0] ? { username: rows[0].username, name: rows[0].name, passHash: rows[0].pass_hash } : null;
    },

    async listAdminLogs(limit = 100) {
      const sql = await db();
      const rows = await sql(`SELECT action, detail, created_at FROM admin_log ORDER BY created_at DESC LIMIT $1`, [limit]);
      return rows.map((r) => ({ action: r.action, detail: r.detail, created_at: new Date(r.created_at).getTime() }));
    },
  };
  return store;
}
