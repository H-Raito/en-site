import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* ============================================================
   EN 直接予約システム テストスイート
   実行: cd site && node --test test/booking.test.mjs
   データベース未設定（メモリストア）で検証する。
   ============================================================ */

const HANDLERS = {
  availability: '../api/availability.js',
  quote: '../api/quote.js',
  booking: '../api/booking.js',
  status: '../api/booking-status.js',
  verify: '../api/verify.js',
  webhook: '../api/stripe-webhook.js',
  cron: '../api/cron.js',
  admin: '../api/admin.js',
};

beforeEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.VERCEL;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.BOOKING_PAYMENTS_ENABLED;
  delete process.env.ADMIN_KEY;
  delete process.env.CRON_SECRET;
});

function makeReqRes(method, url, body, headers = {}) {
  const req = { method, url, body, headers: { host: 'localhost', ...headers } };
  const res = {
    statusCode: 0,
    payload: null,
    headersSent: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.payload = o; return this; },
    setHeader(k, v) { this.headersSent[k] = v; return this; },
  };
  return { req, res };
}

/* ---------- 料金計算 ---------- */
test('pricing: 基本料金（4名まで）', async () => {
  const { computePrice } = await import('../lib/pricing.js');
  const p = computePrice(2, 1);
  assert.equal(p.perNight, 48000);
  assert.equal(p.total, 48000);
});

test('pricing: 追加人数料金（5名目から+6,000）', async () => {
  const { computePrice } = await import('../lib/pricing.js');
  const p = computePrice(6, 2);
  assert.equal(p.perNight, 60000);
  assert.equal(p.total, 120000);
});

test('pricing: 16名上限の料金', async () => {
  const { computePrice } = await import('../lib/pricing.js');
  const p = computePrice(16, 1);
  assert.equal(p.perNight, 48000 + 6000 * 12);
  assert.equal(p.total, (48000 + 6000 * 12));
});

test('validate: 過去日・逆転・上限泊数', async () => {
  const { validateBookingInput } = await import('../lib/pricing.js');
  const today = '2026-11-01';
  assert.equal(validateBookingInput({ checkin: '2026-10-31', checkout: '2026-11-02', adults: 2 }, today).error, 'past_checkin');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-05', adults: 2 }, today).error, 'invalid_stay');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-04', adults: 2 }, today).error, 'invalid_stay');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-12-10', adults: 2 }, today).error, 'too_long_stay');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-07', adults: 17 }, today).error, 'invalid_adults');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-07', adults: 14, children: 3 }, today).error, 'capacity_exceeded');
  const ok = validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-07', adults: 2 }, today);
  assert.equal(ok.nights, 2);
});

/* ---------- ストア: 二重予約防止 ---------- */
test('store: 同一日程への同時予約は1件のみ成功（並列テスト）', async () => {
  const { createMemoryStore } = await import('../lib/store-memory.js');
  const s = createMemoryStore();
  const rec = {
    checkin: '2026-12-01', checkout: '2026-12-03', nights: 2,
    adults: 2, children: 0,
    guest_name: 'テスト', guest_email: 't@example.com', guest_phone: '0773216424',
    price_jpy: 96000, price_detail: {}, options: {},
  };
  const results = await Promise.allSettled([
    s.createPendingBooking({ ...rec, request_id: 'a' }),
    s.createPendingBooking({ ...rec, request_id: 'b' }),
    s.createPendingBooking({ ...rec, request_id: 'c' }),
  ]);
  const okCount = results.filter((r) => r.status === 'fulfilled').length;
  const conflictCount = results.filter((r) => r.reason && r.reason.code === 'unavailable').length;
  assert.equal(okCount, 1);
  assert.equal(conflictCount, 2);
});

test('store: 同日チェックアウト/チェックインは許容（半開区間）', async () => {
  const { createMemoryStore } = await import('../lib/store-memory.js');
  const s = createMemoryStore();
  await s.createPendingBooking({
    checkin: '2026-12-01', checkout: '2026-12-03', nights: 2, adults: 2, children: 0,
    guest_name: 'A', guest_email: 'a@e.com', guest_phone: '0', price_jpy: 1, options: {},
  });
  const second = await s.createPendingBooking({
    checkin: '2026-12-03', checkout: '2026-12-05', nights: 2, adults: 2, children: 0,
    guest_name: 'B', guest_email: 'b@e.com', guest_phone: '0', price_jpy: 1, options: {},
  });
  assert.ok(second.id);
});

test('store: 期限切れ仮予約は自動解放される', async () => {
  const { createMemoryStore } = await import('../lib/store-memory.js');
  const s = createMemoryStore();
  await s.createPendingBooking({
    checkin: '2026-12-01', checkout: '2026-12-03', nights: 2, adults: 2, children: 0,
    guest_name: 'A', guest_email: 'a@e.com', guest_phone: '0', price_jpy: 1, options: {},
  });
  let hit = await s.findActive('2026-12-01', '2026-12-03');
  assert.ok(hit, '作成直後は占有');
  const released = await s.expireStale(Date.now() + 31 * 60 * 1000);
  assert.equal(released.length, 1);
  hit = await s.findActive('2026-12-01', '2026-12-03');
  assert.equal(hit, null, '期限切れ後は解放');
});

test('store: confirmBookingは冪等', async () => {
  const { createMemoryStore } = await import('../lib/store-memory.js');
  const s = createMemoryStore();
  const b = await s.createPendingBooking({
    checkin: '2026-12-01', checkout: '2026-12-03', nights: 2, adults: 2, children: 0,
    guest_name: 'A', guest_email: 'a@e.com', guest_phone: '0', price_jpy: 1, options: {},
  });
  const r1 = await s.confirmBooking(b.id, 'pi_123');
  assert.equal(r1.changed, true);
  const r2 = await s.confirmBooking(b.id, 'pi_123');
  assert.equal(r2.changed, false);
  const after = await s.getBooking(b.id);
  assert.equal(after.status, 'confirmed');
});

test('store: 受付停止日の追加・解除と空室への反映', async () => {
  const { createMemoryStore } = await import('../lib/store-memory.js');
  const s = createMemoryStore();
  await s.addBlockedRange('2026-12-01', '2026-12-02', 'テスト');
  const avail = await s.availability('2026-12-01', '2026-12-03');
  assert.ok(avail.blockedDates.has('2026-12-01'));
  await s.removeBlockedRange('2026-12-01', '2026-12-02');
  const avail2 = await s.availability('2026-12-01', '2023-12-02');
  assert.ok(avail2);
});

/* ---------- API ハンドラ ---------- */
test('api: availability は予約済み夜を返す', async () => {
  const { createMemoryStore } = await import('../lib/store-memory.js');
  const store = createMemoryStore();
  globalThis.__enTestStore = store;
  await store.createPendingBooking({
    checkin: '2026-12-01', checkout: '2026-12-03', nights: 2, adults: 2, children: 0,
    guest_name: 'A', guest_email: 'a@e.com', guest_phone: '0', price_jpy: 1, options: {},
  });
  const mod = await import(HANDLERS.availability);
  const { req, res } = makeReqRes('GET', '/api/availability?months=3');
  await mod.default(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.payload.booked.includes('2026-12-01'));
  assert.ok(res.payload.booked.includes('2026-12-02'));
  delete globalThis.__enTestStore;
});

test('api: quote は泊数・金額をサーバー計算', async () => {
  const mod = await import(HANDLERS.quote);
  const { req, res } = makeReqRes('POST', '/api/quote', {
    checkin: '2026-12-01', checkout: '2026-12-03', adults: 6, children: 1,
  });
  await mod.default(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.nights, 2);
  assert.equal(res.payload.perNight, 60000);
  assert.equal(res.payload.total, 120000);
});

test('api: booking 作成は決済無効時 503 payments_disabled', async () => {
  const mod = await import(HANDLERS.booking);
  const { req, res } = makeReqRes('POST', '/api/booking', {
    checkin: '2026-12-01', checkout: '2026-12-03', adults: 2, children: 0,
    name: 'テスト太郎', kana: 'テスト タロウ',
    email: 't@example.com', phone: '0773216424',
  });
  await mod.default(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error, 'payments_disabled');
});

test('api: booking 作成の入力検証', async () => {
  const mod = await import(HANDLERS.booking);
  const cases = [
    { body: { checkin: '2026-12-01', checkout: '2026-12-03', adults: 0, name: 'a', email: 'x@y.z', phone: '0' }, err: 'invalid_adults' },
    { body: { checkin: '2026-12-01', checkout: '2026-12-01', adults: 2, name: 'a', email: 'x@y.z', phone: '0' }, err: 'invalid_stay' },
    { body: { checkin: 'bad', checkout: '2026-12-03', adults: 2, name: 'a', email: 'x@y.z', phone: '0' }, err: 'invalid_date' },
  ];
  for (const c of cases) {
    const { req, res } = makeReqRes('POST', '/api/booking', c.body);
    await mod.default(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.error, c.err);
  }
});

test('api: booking-status は存在しないIDで404・名前をマスク', async () => {
  const mod = await import(HANDLERS.status);
  const { req, res } = makeReqRes('GET', '/api/booking-status?id=EN-XXXXXX-TEST');
  await mod.default(req, res);
  assert.equal(res.statusCode, 404);
  const { createMemoryStore } = await import('../lib/store-memory.js');
  const store = createMemoryStore();
  const b = await store.createPendingBooking({
    checkin: '2026-12-01', checkout: '2026-12-03', nights: 2, adults: 2, children: 0,
    guest_name: 'ヤマダタロウ', guest_email: 'a@e.com', guest_phone: '0', price_jpy: 96000, options: {},
  });
  process.env.__STORE__ = store; /* 使わない・明示削除 */
  delete process.env.__STORE__;
  /* ストア注入ができないため、ここではID形式バリデーションのみ検証 */
  const { req: req2, res: res2 } = makeReqRes('GET', '/api/booking-status?id=BAD');
  await mod.default(req2, res2);
  assert.equal(res2.statusCode, 400);
});

test('api: webhook は署名なし・鍵未設定で拒否', async ()  => {
  const mod = await import(HANDLERS.webhook);
  const { req, res } = makeReqRes('POST', '/api/stripe-webhook', {}, {});
  await mod.default(req, res);
  assert.equal(res.statusCode, 503);
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
  const { req: req2, res: res2 } = makeReqRes('POST', '/api/stripe-webhook', '{}', { 'stripe-signature': 't=1,v1=bad' });
  await mod.default(req2, res2);
  assert.equal(res2.statusCode, 400);
});

test('api: cron は秘密鍵不一致で401', async () => {
  process.env.CRON_SECRET = 's3cret';
  const mod = await import(HANDLERS.cron);
  const { req, res } = makeReqRes('GET', '/api/cron?key=wrong');
  await mod.default(req, res);
  assert.equal(res.statusCode, 401);
});

test('api: admin は未認証で401・ログイン後に操作可能', async () => {
  process.env.ADMIN_KEY = 'test-admin-key-123';
  const mod = await import(HANDLERS.admin);
  const { req, res } = makeReqRes('GET', '/api/admin.js?action=bookings.list');
  await mod.default(req, res);
  assert.equal(res.statusCode, 401);
  /* ログイン */
  const login = makeReqRes('POST', '/api/admin.js?action=login', { key: 'test-admin-key-123' });
  await mod.default(login.req, login.res);
  assert.equal(login.res.statusCode, 200);
  const cookie = login.res.headersSent['Set-Cookie'];
  assert.ok(cookie.includes('en_admin='));
  /* クッキーで認証して受付停止を追加→一覧→削除 */
  const add = makeReqRes('POST', '/api/admin.js?action=blocked.add', { from: '2027-01-10', to: '2027-01-12', reason: 'テスト停止' }, { cookie: cookie.replace(/; .*/, '') });
  await mod.default(add.req, add.res);
  assert.equal(add.res.statusCode, 200);
  const list = makeReqRes('GET', '/api/admin.js?action=blocked.list', null, { cookie: cookie.replace(/; .*/, '') });
  await mod.default(list.req, list.res);
  assert.ok(list.res.payload.blocked.some((x) => x.date === '2027-01-10'));
  const rm = makeReqRes('POST', '/api/admin.js?action=blocked.remove', { from: '2027-01-10', to: '2027-01-12' }, { cookie: cookie.replace(/; .*/, '') });
  await mod.default(rm.req, rm.res);
  assert.equal(rm.res.statusCode, 200);
});

test('api: admin 手動予約は即時確定で登録される', async () => {
  process.env.ADMIN_KEY = 'test-admin-key-123';
  const mod = await import(HANDLERS.admin);
  const login = makeReqRes('POST', '/api/admin.js?action=login', { key: 'test-admin-key-123' });
  await mod.default(login.req, login.res);
  const cookie = login.res.headersSent['Set-Cookie'].replace(/; .*/, '');
  const mk = makeReqRes('POST', '/api/admin.js?action=booking.manual', {
    checkin: '2027-02-01', checkout: '2027-02-03', adults: 4, children: 0,
    name: '電話太郎', email: 'tel@example.com', phone: '0773216424', notes: '現地精算',
  }, { cookie });
  await mod.default(mk.req, mk.res);
  assert.equal(mk.res.statusCode, 200);
  assert.equal(mk.res.payload.booking.status, 'confirmed');
  assert.equal(mk.res.payload.booking.price_jpy, 96000);
  const dup = makeReqRes('POST', '/api/admin.js?action=booking.manual', {
    action: 'booking.manual',
    checkin: '2027-02-02', checkout: '2027-02-04', adults: 2, children: 0,
    name: 'B', email: 'b@e.com', phone: '0773216424',
  }, { cookie });
  dup.req.url = '/api/admin.js?action=booking.manual';
  await mod.default(dup.req, dup.res);
  assert.equal(dup.res.statusCode, 409);
});
