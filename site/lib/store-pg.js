// 本番用 Postgres ストア（Neon・@neondatabase/serverless の Pool を使用）。
// Pool.query は (text, values) 形式をサポート。トランザクションは明示的な BEGIN/COMMIT。
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
  expires_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ
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
/* 既存DBへのマイグレーション（CREATE TABLE IF NOT EXISTSは列追加を行わないため） */
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
`;

export function createPgStore(databaseUrl) {
  let pool = null;
  let ready = null;

  async function db() {
    if (!pool) {
      const mod = await import('@neondatabase/serverless');
      pool = new mod.Pool({ connectionString: databaseUrl });
    }
    if (!ready) {
      /* スキーマは1回の往復でまとめて実行（コールドスタートの遅延軽減）。
         ドライバが複数文を許可しない場合は1文ずつにフォールバック（全文IF NOT EXISTSで冪等）。 */
      const stmts = SCHEMA.split(';').map((x) => x.trim()).filter(Boolean);
      ready = pool.query(SCHEMA).catch(async () => {
        for (const stmt of stmts) await pool.query(stmt);
      });
      ready.catch(() => { ready = null; });
    }
    await ready;
    return pool;
  }

  /* トランザクション: 専用クライアントで BEGIN〜COMMIT/ROLLBACK */
  async function tx(fn) {
    const pool = await db();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const q = (text, values) => client.query(text, values);
      const result = await fn(q);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (e2) {}
      throw e;
    } finally {
      client.release();
    }
  }

  const ACTIVE = "(status = 'confirmed' OR (status = 'pending_payment' AND (expires_at IS NULL OR expires_at > now())))";

  function rowToBooking(r) {
    return {
      id: r.id,
      request_id: r.request_id,
      checkin: dateStr(r.checkin),
      checkout: dateStr(r.checkout),
      nights: r.nights,
      adults: r.adults,
      infants: r.infants,
      confirmed_at: r.confirmed_at ? new Date(r.confirmed_at).getTime() : null,
      payment_method: r.payment_method,
      options_online: r.options_online,
      options_onsite: r.options_onsite,
      online_total: r.online_total,
      onsite_amount: r.onsite_amount,
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
      refund_id: r.refund_id,
      refund_amount: r.refund_amount,
      email_status: r.email_status,
      thankyou_sent: r.thankyou_sent,
      admin_memo: r.admin_memo,
      source: r.source,
      created_at: r.created_at ? new Date(r.created_at).getTime() : null,
      updated_at: r.updated_at ? new Date(r.updated_at).getTime() : null,
      expires_at: r.expires_at ? new Date(r.expires_at).getTime() : null,
      paid_at: r.paid_at ? new Date(r.paid_at).getTime() : null,
    };
  }

  function dateStr(v) {
    return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  }

  const store = {
    kind: 'postgres',

    async createPendingBooking(rec) {
      return tx(async (q) => {
        /* 同一日程への同時作成を直列化する。FOR UPDATE は「見つかった行」にしか
           掛からないため、空き日は0件で鍵が無く二重予約になりうる（Issue #8）。
           予約作成者は全員が先に同じ番号の鍵を取り、待った後の検索で重複を判定する */
        await q('SELECT pg_advisory_xact_lock(1)');
        const overlap = await q(
          `SELECT id FROM bookings
           WHERE ${ACTIVE}
             AND checkin < $2::date AND checkout > $1::date
           FOR UPDATE`,
          [rec.checkin, rec.checkout]
        );
        if (overlap.rows.length > 0) {
          const e = new Error('指定の日程は予約できません');
          e.code = 'unavailable';
          throw e;
        }
        const blockedRows = await q(
          `SELECT date FROM blocked_dates WHERE date >= $1::date AND date < $2::date FOR UPDATE`,
          [rec.checkin, rec.checkout]
        );
        if (blockedRows.rows.length > 0) {
          const e = new Error('指定の日程は予約できません');
          e.code = 'unavailable';
          throw e;
        }
        const id = newBookingId();
        const rows = await q(
          `INSERT INTO bookings
            (id, request_id, checkin, checkout, nights, adults, infants,
             guest_name, guest_kana, guest_email, guest_phone, guest_address,
             arrival_time, notes, options, price_jpy, price_detail,
             payment_method, options_online, options_onsite, online_total, onsite_amount,
             status, source, expires_at)
           VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,
             $18,$19,$20,$21,$22,'pending_payment',$23, now() + interval '30 minutes')
           RETURNING *`,
          [id, rec.request_id || null, rec.checkin, rec.checkout, rec.nights, rec.adults, rec.infants || 0,
            rec.guest_name, rec.guest_kana || '', rec.guest_email, rec.guest_phone, rec.guest_address || '',
            rec.arrival_time || '', rec.notes || '', JSON.stringify(rec.options || {}),
            rec.price_jpy, JSON.stringify(rec.price_detail || {}),
            rec.payment_method || 'online', rec.options_online || 0, rec.options_onsite || 0,
            rec.online_total || 0, rec.onsite_amount || 0, rec.source || 'web']
        );
        return rowToBooking(rows.rows[0]);
      });
    },

    async findActive(checkin, checkout) {
      const pool = await db();
      const rows = await pool.query(
        `SELECT id FROM bookings WHERE ${ACTIVE} AND checkin < $2::date AND checkout > $1::date LIMIT 1`,
        [checkin, checkout]
      );
      return rows.rows[0] ? rows.rows[0].id : null;
    },

    async getBooking(id) {
      const pool = await db();
      const rows = await pool.query(`SELECT * FROM bookings WHERE id = $1`, [id]);
      return rows.rows[0] ? rowToBooking(rows.rows[0]) : null;
    },

    async getBookingByRequest(requestId) {
      const pool = await db();
      const rows = await pool.query(`SELECT * FROM bookings WHERE request_id = $1`, [requestId]);
      return rows.rows[0] ? rowToBooking(rows.rows[0]) : null;
    },

    async listBookings(filter = {}) {
      const pool = await db();
      const conds = [];
      const args = [];
      if (filter.status) { args.push(filter.status); conds.push(`status = $${args.length}`); }
      if (filter.q) {
        args.push('%' + filter.q.toLowerCase() + '%');
        const n = args.length;
        conds.push(`(LOWER(id) LIKE $${n} OR LOWER(guest_name) LIKE $${n} OR LOWER(guest_email) LIKE $${n} OR guest_phone LIKE $${n})`);
      }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const rows = await pool.query(`SELECT * FROM bookings ${where} ORDER BY created_at DESC LIMIT 500`, args);
      return rows.rows.map(rowToBooking);
    },

    async confirmBooking(id, paymentIntentId) {
      const pool = await db();
      const rows = await pool.query(
        `UPDATE bookings
         SET status='confirmed', confirmed_at=now(), payment_intent_id=COALESCE($2, payment_intent_id),
             expires_at=NULL, updated_at=now()
         WHERE id=$1 AND status='pending_payment'
         RETURNING *`,
        [id, paymentIntentId || null]
      );
      if (rows.rows.length > 0) return { booking: rowToBooking(rows.rows[0]), changed: true };
      const cur = await pool.query(`SELECT * FROM bookings WHERE id=$1`, [id]);
      if (!cur.rows[0]) { const e = new Error('not found'); e.code = 'not_found'; throw e; }
      if (cur.rows[0].status === 'confirmed') return { booking: rowToBooking(cur.rows[0]), changed: false };
      const e = new Error('invalid status: ' + cur.rows[0].status);
      e.code = 'invalid_status';
      throw e;
    },

    async updateBookingIfConfirmed(id, patch) {
      const pool = await db();
      const rows = await pool.query(
        `UPDATE bookings
         SET status = $2, refund_amount = COALESCE($3, refund_amount),
             admin_memo = COALESCE($4, admin_memo), updated_at = now()
         WHERE id = $1 AND status = 'confirmed'
         RETURNING *`,
        [id, patch.status || 'refunded', patch.refund_amount != null ? patch.refund_amount : null,
         patch.admin_memo != null ? patch.admin_memo : null]
      );
      return rows.rows[0] ? rowToBooking(rows.rows[0]) : null;
    },

    /* 入金記録: confirmed のみ・冪等（2回押しても paid_at は変わらない） */
    async markBookingPaid(id, memo) {
      const pool = await db();
      const rows = await pool.query(
        `UPDATE bookings
         SET paid_at = now(), admin_memo = COALESCE($2, admin_memo), updated_at = now()
         WHERE id = $1 AND status = 'confirmed' AND paid_at IS NULL
         RETURNING *`,
        [id, memo != null ? memo : null]
      );
      return rows.rows[0] ? rowToBooking(rows.rows[0]) : null;
    },

    /* 入金記録の取り消し: confirmed かつ記録済みのときだけ（未記録なら null） */
    async unmarkBookingPaid(id, memo) {
      const pool = await db();
      const rows = await pool.query(
        `UPDATE bookings
         SET paid_at = NULL, admin_memo = COALESCE($2, admin_memo), updated_at = now()
         WHERE id = $1 AND status = 'confirmed' AND paid_at IS NOT NULL
         RETURNING *`,
        [id, memo != null ? memo : null]
      );
      return rows.rows[0] ? rowToBooking(rows.rows[0]) : null;
    },

    async setBookingStatus(id, status, extra = {}) {
      const pool = await db();
      const rows = await pool.query(
        `UPDATE bookings SET status=$2, admin_memo=COALESCE($3, admin_memo), updated_at=now() WHERE id=$1 RETURNING *`,
        [id, status, extra.memo != null ? String(extra.memo).slice(0, 2000) : null]
      );
      if (!rows.rows[0]) { const e = new Error('not found'); e.code = 'not_found'; throw e; }
      return rowToBooking(rows.rows[0]);
    },

    async setStripeSession(id, sessionId) {
      const pool = await db();
      await pool.query(`UPDATE bookings SET stripe_session_id=$2, updated_at=now() WHERE id=$1`, [id, sessionId]);
    },

    async updateBooking(id, patch) {
      const pool = await db();
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
      const rows = await pool.query(`UPDATE bookings SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, args);
      return rowToBooking(rows.rows[0]);
    },

    async expireStale(now = Date.now()) {
      const pool = await db();
      const rows = await pool.query(
        `UPDATE bookings SET status='expired', updated_at=now()
         WHERE status='pending_payment' AND expires_at IS NOT NULL AND expires_at < now()
         RETURNING id`
      );
      return rows.rows.map((r) => r.id);
    },

    async availability(checkin, checkout) {
      const pool = await db();
      const rows = await pool.query(
        `SELECT checkin, checkout FROM bookings WHERE ${ACTIVE} AND checkin < $2::date AND checkout > $1::date`,
        [checkin, checkout]
      );
      const bookedNights = new Set();
      for (const r of rows.rows) for (const n of eachNight(dateStr(r.checkin), dateStr(r.checkout))) bookedNights.add(n);
      const brows = await pool.query(`SELECT date FROM blocked_dates WHERE date >= $1::date AND date < $2::date`, [checkin, checkout]);
      const blockedDates = new Set(brows.rows.map((r) => dateStr(r.date)));
      return { bookedNights, blockedDates };
    },

    async listBlocked() {
      const pool = await db();
      const rows = await pool.query(`SELECT date, reason FROM blocked_dates ORDER BY date`);
      return rows.rows.map((r) => ({ date: dateStr(r.date), reason: r.reason || '' }));
    },

    async addBlockedRange(from, to, reason) {
      /* 予約作成と同じ鍵を取ることで、予約と受付停止の同時実行も直列化する（Issue #8） */
      return tx(async (q) => {
        await q('SELECT pg_advisory_xact_lock(1)');
        await q(
          `INSERT INTO blocked_dates (date, reason)
           SELECT d::date, $3 FROM generate_series($1::date, $2::date, interval '1 day') d
           ON CONFLICT (date) DO NOTHING`,
          [from, to, reason || '']
        );
        return true;
      });
    },

    async removeBlockedRange(from, to) {
      const pool = await db();
      await pool.query(`DELETE FROM blocked_dates WHERE date BETWEEN $1::date AND $2::date`, [from, to]);
      return true;
    },

    async getSettings() {
      const pool = await db();
      const rows = await pool.query(`SELECT key, value FROM settings`);
      const out = {};
      for (const r of rows.rows) out[r.key] = r.value;
      return out;
    },

    async saveSettings(patch) {
      const pool = await db();
      for (const [k, v] of Object.entries(patch)) {
        await pool.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
          [k, JSON.stringify(v)]
        );
      }
      return store.getSettings();
    },

    async logEmail(rec) {
      const pool = await db();
      await pool.query(`INSERT INTO email_log (booking_id, kind, status, detail) VALUES ($1,$2,$3,$4)`,
        [rec.booking_id, rec.kind, rec.status, rec.detail || '']);
    },

    async emailFailCount(bookingId) {
      const pool = await db();
      const rows = await pool.query(`SELECT count(*)::int AS c FROM email_log WHERE booking_id=$1 AND status='failed'`, [bookingId]);
      return rows.rows[0].c;
    },

    async logAdmin(action, detail) {
      const pool = await db();
      await pool.query(`INSERT INTO admin_log (action, detail) VALUES ($1, $2::jsonb)`, [action, detail ? JSON.stringify(detail) : null]);
    },

    async listAdminLogs(limit = 100) {
      const pool = await db();
      const rows = await pool.query(`SELECT action, detail, created_at FROM admin_log ORDER BY created_at DESC LIMIT $1`, [limit]);
      return rows.rows.map((r) => ({ action: r.action, detail: r.detail, created_at: new Date(r.created_at).getTime() }));
    },

    async ensureAdminUsers(entries) {
      const pool = await db();
      for (const e of entries) {
        await pool.query(
          `INSERT INTO admin_users (username, name, pass_hash) VALUES ($1, $2, $3)
           ON CONFLICT (username) DO NOTHING`,
          [e.username, e.name, e.passHash]
        );
      }
      return true;
    },

    async getAdminUser(username) {
      const pool = await db();
      const rows = await pool.query(`SELECT username, name, pass_hash FROM admin_users WHERE username = $1`, [username]);
      return rows.rows[0] ? { username: rows.rows[0].username, name: rows.rows[0].name, passHash: rows.rows[0].pass_hash } : null;
    },
  };
  return store;
}
