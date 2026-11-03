import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* ============================================================
   EN 直接予約システム テストスイート（2026-11 確定仕様）
   実行: cd site && node --test test/booking.test.mjs
   ============================================================ */

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
    statusCode: 0, payload: null, hs: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.payload = o; return this; },
    setHeader(k, v) { this.hs[k] = v; return this; },
  };
  return { req, res };
}

async function makeStore() {
  const { createMemoryStore } = await import('../lib/store-memory.js');
  return createMemoryStore();
}

async function seedBooking(store, checkin, checkout, opts = {}) {
  const nights = Math.round((new Date(checkout + 'T00:00:00Z') - new Date(checkin + 'T00:00:00Z')) / 86400000);
  return store.createPendingBooking({
    checkin, checkout, nights,
    adults: opts.adults || 2, infants: opts.infants || 0,
    guest_name: opts.name || 'テスト', guest_email: opts.email || 't@example.com',
    guest_phone: '0773216424',
    price_jpy: opts.price != null ? opts.price : 96000,
    price_detail: opts.price_detail || {
      perNight: 48000, staySubtotal: 96000, optionsOnline: 0, optionsOnsite: 0,
      onlineTotal: 96000, onsiteAmount: 0, adults: opts.adults || 2, nights,
    },
    options: opts.options || {},
    payment_method: opts.payment_method || 'online',
    options_online: opts.options_online || 0,
    options_onsite: opts.options_onsite || 0,
    online_total: opts.online_total != null ? opts.online_total : 96000,
    onsite_amount: opts.onsite_amount || 0,
    source: opts.source || 'web',
  });
}

const TODAY = '2026-11-01';

/* ---------- 料金計算（確定仕様） ---------- */
test('pricing: 4名1泊=48,000円', async () => {
  const { computePrice } = await import('../lib/pricing.js');
  assert.equal(computePrice(4, 1).onlineTotal, 48000);
});

test('pricing: 5名1泊=54,000円', async () => {
  const { computePrice } = await import('../lib/pricing.js');
  assert.equal(computePrice(5, 1).onlineTotal, 54000);
});

test('pricing: 10名1泊=84,000円', async () => {
  const { computePrice } = await import('../lib/pricing.js');
  assert.equal(computePrice(10, 1).onlineTotal, 84000);
});

test('pricing: 16名1泊=120,000円', async () => {
  const { computePrice } = await import('../lib/pricing.js');
  assert.equal(computePrice(16, 1).onlineTotal, 120000);
});

test('pricing: 乳幼児は無料・アーリーは徴収しない', async () => {
  const { computePrice } = await import('../lib/pricing.js');
  const p = computePrice(16, 2, { bbq: true, sauna: true, earlyCheckin: true }, 'online');
  assert.equal(p.staySubtotal, 240000);
  assert.equal(p.optionsOnline, 4000);
  assert.equal(p.optionsOnsite, 5000);
  assert.equal(p.onlineTotal, 244000);
  assert.equal(p.onsiteAmount, 5000);
});

test('pricing: 現地払い選択時はオプションを現地分に計上', async () => {
  const { computePrice } = await import('../lib/pricing.js');
  const p = computePrice(2, 1, { bbq: true, sauna: true, earlyCheckin: true }, 'onsite');
  assert.equal(p.onlineTotal, 48000);
  assert.equal(p.onsiteAmount, 9000);
});

test('pricing: 泊数倍にしない（2泊でもオプションは1予約分）', async () => {
  const { computePrice } = await import('../lib/pricing.js');
  const p = computePrice(4, 2, { bbq: true }, 'online');
  assert.equal(p.optionsOnline, 2000);
});

/* ---------- 検証 ---------- */
test('validate: 過去日・同日・逆転・上限泊数・人数', async () => {
  const { validateBookingInput } = await import('../lib/pricing.js');
  const t = TODAY;
  const nowFixed = Date.UTC(2026, 10, 1, 6, 0, 0);
  assert.equal(validateBookingInput({ checkin: '2026-10-31', checkout: '2026-11-02', adults: 2 }, t, nowFixed).error, 'past_checkin');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-05', adults: 2 }, t, nowFixed).error, 'invalid_stay');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-04', adults: 2 }, t, nowFixed).error, 'invalid_stay');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-12-10', adults: 2 }, t, nowFixed).error, 'too_long_stay');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-07', adults: 0 }, t, nowFixed).error, 'invalid_adults');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-07', adults: 17 }, t, nowFixed).error, 'invalid_adults');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-07', adults: 16, infants: 1 }, t, nowFixed).error, 'capacity_exceeded');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-07', adults: 2, infants: 6 }, t, nowFixed).error, 'invalid_infants');
  assert.equal(validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-07', adults: 2, paymentMethod: 'xxx' }, t, nowFixed).error, 'invalid_payment_method');
  const ok = validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-07', adults: 16, infants: 0 }, t, nowFixed);
  assert.equal(ok.nights, 2);
  const ok2 = validateBookingInput({ checkin: '2026-11-05', checkout: '2026-11-07', adults: 15, infants: 1 }, t, nowFixed);
  assert.equal(ok2.ok, true);
});

test('cutoff: チェックイン3日前の15:00境界（日本時間）', async () => {
  const { validateBookingInput, isPastCutoff } = await import('../lib/pricing.js');
  /* チェックイン 2026-11-04 → 期限は 2026-11-01 15:00 JST = 2026-11-01T06:00Z */
  const deadline = Date.UTC(2026, 10, 1, 6, 0, 0);
  const before = validateBookingInput(
    { checkin: '2026-11-04', checkout: '2026-11-05', adults: 2 },
    '2026-11-01', deadline - 1
  );
  assert.equal(before.ok, true);
  const at = validateBookingInput(
    { checkin: '2026-11-04', checkout: '2026-11-05', adults: 2 },
    '2026-11-01', deadline
  );
  assert.equal(at.ok, true); /* 「まで」は含む */
  const after = validateBookingInput(
    { checkin: '2026-11-04', checkout: '2026-11-05', adults: 2 },
    '2026-11-01', deadline + 1
  );
  assert.equal(after.error, 'booking_closed');
  assert.equal(isPastCutoff('bad', deadline), true);
});

/* ---------- ストア ---------- */
test('store: 同一日程への同時予約は1件のみ成功', async () => {
  const s = await makeStore();
  const rec = {
    checkin: '2026-12-01', checkout: '2026-12-03', nights: 2,
    adults: 2, infants: 0,
    guest_name: 'テスト', guest_email: 't@example.com', guest_phone: '0773216424',
    price_jpy: 96000, price_detail: {}, options: {},
  };
  const results = await Promise.allSettled([
    s.createPendingBooking({ ...rec, request_id: 'a' }),
    s.createPendingBooking({ ...rec, request_id: 'b' }),
    s.createPendingBooking({ ...rec, request_id: 'c' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.reason && r.reason.code === 'unavailable').length, 2);
});

test('store: 同日チェックアウト/チェックインは許容', async () => {
  const s = await makeStore();
  await seedBooking(s, '2026-12-01', '2026-12-03');
  const second = await seedBooking(s, '2026-12-03', '2026-12-05');
  assert.ok(second.id);
});

test('store: 期限切れ仮予約は自動解放', async () => {
  const s = await makeStore();
  await seedBooking(s, '2026-12-01', '2026-12-03');
  const released = await s.expireStale(Date.now() + 31 * 60 * 1000);
  assert.equal(released.length, 1);
  assert.equal(await s.findActive('2026-12-01', '2026-12-03'), null);
});

test('store: confirmBookingは冪等', async () => {
  const s = await makeStore();
  const b = await seedBooking(s, '2026-12-01', '2026-12-03');
  assert.equal((await s.confirmBooking(b.id, 'pi_1')).changed, true);
  assert.equal((await s.confirmBooking(b.id, 'pi_1')).changed, false);
});

test('store: updateBookingIfConfirmed は confirmed からのみ遷移（二重返金防止）', async () => {
  const s = await makeStore();
  const b = await seedBooking(s, '2026-12-01', '2026-12-03');
  await s.confirmBooking(b.id, 'pi_1');
  const reserved = await s.updateBookingIfConfirmed(b.id, { status: 'refunded', refund_amount: 48000 });
  assert.ok(reserved);
  const again = await s.updateBookingIfConfirmed(b.id, { status: 'refunded', refund_amount: 48000 });
  assert.equal(again, null);
});

test('store: 受付停止日の反映と解除', async () => {
  const s = await makeStore();
  await s.addBlockedRange('2026-12-01', '2026-12-02', 'テスト');
  const avail = await s.availability('2026-12-01', '2026-12-03');
  assert.ok(avail.blockedDates.has('2026-12-01'));
  await s.removeBlockedRange('2026-12-01', '2026-12-02');
  assert.equal((await s.listBlocked()).length, 0);
});

/* ---------- キャンセル返金計算 ---------- */
test('refund: 無料キャンセル期限内は100%', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  /* チェックイン 2026-12-10 → 無料期限 2026-12-05 15:00 JST (= 2026-12-05T06:00Z) */
  const b = { checkin: '2026-12-10', nights: 1, adults: 2,
    price_detail: { perNight: 48000, staySubtotal: 48000, optionsOnline: 2000 } };
  const r = calculateRefund(b, Date.UTC(2026, 11, 5, 6, 0, 0));
  assert.equal(r.tier, 'full');
  assert.equal(r.refundJpy, 48000);
  assert.equal(r.optionsRefundJpy, 2000);
});

test('refund: 期限後〜当日15:00未満は1泊目無償・2泊目以降50%', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  const b = { checkin: '2026-12-10', nights: 3, adults: 2,
    price_detail: { perNight: 48000, staySubtotal: 144000, optionsOnline: 0 } };
  const r = calculateRefund(b, Date.UTC(2026, 11, 6, 6, 0, 0));
  assert.equal(r.tier, 'partial');
  assert.equal(r.refundJpy, 48000); /* 2泊目分の50%=24,000 × 2泊 = 48,000 */
});

test('refund: 当日15:00以降は返金なし（案）', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  const b = { checkin: '2026-12-10', nights: 2, adults: 2,
    price_detail: { perNight: 48000, staySubtotal: 96000, optionsOnline: 0 } };
  const r = calculateRefund(b, Date.UTC(2026, 11, 10, 6, 0, 1));
  assert.equal(r.tier, 'none');
  assert.equal(r.refundJpy, 0);
});

test('refund: 1泊予約は期限後返金0円', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  const b = { checkin: '2026-12-10', nights: 1, adults: 2,
    price_detail: { perNight: 48000, staySubtotal: 48000, optionsOnline: 0 } };
  const r = calculateRefund(b, Date.UTC(2026, 11, 6, 0, 0, 0));
  assert.equal(r.tier, 'partial');
  assert.equal(r.refundJpy, 0);
});

/* ---------- API ---------- */
test('api: availability は予約済み夜を返す', async () => {
  const store = await makeStore();
  globalThis.__enTestStore = store;
  await seedBooking(store, '2026-12-01', '2026-12-03');
  const mod = await import('../api/availability.js');
  const { req, res } = makeReqRes('GET', '/api/availability?months=3');
  await mod.default(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.payload.booked.includes('2026-12-01'));
  assert.ok(res.payload.booked.includes('2026-12-02'));
  delete globalThis.__enTestStore;
});

test('api: quote は泊数・金額・オプション分離をサーバー計算', async () => {
  globalThis.__enTestStore = await makeStore();
  const mod = await import('../api/quote.js');
  const { req, res } = makeReqRes('POST', '/api/quote', {
    checkin: '2026-12-01', checkout: '2026-12-03',
    adults: 6, infants: 1, bbq: true, sauna: true, earlyCheckin: true,
    paymentMethod: 'onsite',
  });
  await mod.default(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.nights, 2);
  assert.equal(res.payload.perNight, 60000);
  assert.equal(res.payload.subtotal, 120000);
  assert.equal(res.payload.onlineTotal, 120000);
  assert.equal(res.payload.onsiteAmount, 9000);
  delete globalThis.__enTestStore;
});

test('api: booking 作成は決済無効時 503', async () => {
  globalThis.__enTestStore = await makeStore();
  const mod = await import('../api/booking.js');
  const { req, res } = makeReqRes('POST', '/api/booking', {
    checkin: '2026-12-01', checkout: '2026-12-03', adults: 2, infants: 0,
    name: 'テスト太郎', kana: 'テスト タロウ', email: 't@example.com', phone: '0773216424',
  });
  await mod.default(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error, 'payments_disabled');
  delete globalThis.__enTestStore;
});

test('api: booking 作成の入力検証', async () => {
  globalThis.__enTestStore = await makeStore();
  const mod = await import('../api/booking.js');
  const cases = [
    { body: { checkin: '2026-12-01', checkout: '2026-12-03', adults: 0, name: 'a', email: 'x@y.z', phone: '0773216424' }, err: 'invalid_adults' },
    { body: { checkin: '2026-12-01', checkout: '2026-12-01', adults: 2, name: 'a', email: 'x@y.z', phone: '0773216424' }, err: 'invalid_stay' },
    { body: { checkin: 'bad', checkout: '2026-12-03', adults: 2, name: 'a', email: 'x@y.z', phone: '0773216424' }, err: 'invalid_date' },
    { body: { checkin: '2026-12-01', checkout: '2026-12-03', adults: 2, name: '', email: 'x@y.z', phone: '0773216424' }, err: 'invalid_name' },
    { body: { checkin: '2026-12-01', checkout: '2026-12-03', adults: 2, name: 'a', email: 'bad', phone: '0773216424' }, err: 'invalid_email' },
    { body: { checkin: '2026-12-01', checkout: '2026-12-03', adults: 2, name: 'a', email: 'x@y.z', phone: '0' }, err: 'invalid_phone' },
  ];
  for (const c of cases) {
    const { req, res } = makeReqRes('POST', '/api/booking', c.body);
    await mod.default(req, res);
    assert.equal(res.statusCode, 400, c.err);
    assert.equal(res.payload.error, c.err);
  }
  delete globalThis.__enTestStore;
});

test('api: booking-status は404/400/マスクを返す', async () => {
  globalThis.__enTestStore = await makeStore();
  const store = globalThis.__enTestStore;
  const mod = await import('../api/booking-status.js');
  const { req, res } = makeReqRes('GET', '/api/booking-status?id=EN-XXXXXX-TEST');
  await mod.default(req, res);
  assert.equal(res.statusCode, 404);
  const { req: r2, res: s2 } = makeReqRes('GET', '/api/booking-status?id=BAD');
  await mod.default(r2, s2);
  assert.equal(s2.statusCode, 400);
  const b = await seedBooking(store, '2026-12-01', '2026-12-03', { name: 'ヤマダタロウ' });
  const { req: r3, res: s3 } = makeReqRes('GET', '/api/booking-status?id=' + b.id);
  await mod.default(r3, s3);
  assert.equal(s3.statusCode, 200);
  assert.equal(s3.payload.guestNameMasked, 'ヤ○○○○○');
  assert.equal(s3.payload.infants, 0);
  delete globalThis.__enTestStore;
});

test('api: webhook は鍵未設定503・署名不正400', async () => {
  const mod = await import('../api/stripe-webhook.js');
  const { req, res } = makeReqRes('POST', '/api/stripe-webhook', {}, {});
  await mod.default(req, res);
  assert.equal(res.statusCode, 503);
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
  const { req: r2, res: s2 } = makeReqRes('POST', '/api/stripe-webhook', '{}', { 'stripe-signature': 't=1,v1=bad' });
  await mod.default(r2, s2);
  assert.equal(s2.statusCode, 400);
});

test('api: cron は秘密鍵不一致で401', async () => {
  process.env.CRON_SECRET = 's3cret';
  const mod = await import('../api/cron.js');
  const { req, res } = makeReqRes('GET', '/api/cron?key=wrong');
  await mod.default(req, res);
  assert.equal(res.statusCode, 401);
});

test('api: admin 未認証401・CSRF拒否・ログイン後に操作', async () => {
  process.env.ADMIN_KEY = 'test-admin-key-123';
  process.env.ADMIN_SEED = 'サイト管理者:admin:testpass123,施設オーナー:owner:testpass456';
  const mod = await import('../api/admin.js');
  const noauth = makeReqRes('GET', '/api/admin.js?action=bookings.list');
  await mod.default(noauth.req, noauth.res);
  assert.equal(noauth.res.statusCode, 401);
  /* ログイン（ユーザー名+パスワード） */
  const login = makeReqRes('POST', '/api/admin.js?action=login', { username: 'admin', password: 'testpass123' });
  await mod.default(login.req, login.res);
  assert.equal(login.res.statusCode, 200);
  const cookie = login.res.hs['Set-Cookie'].replace(/; .*/, '');
  /* CSRFヘッダなしの変更系POSTは403 */
  const noCsrf = makeReqRes('POST', '/api/admin.js?action=blocked.add',
    { action: 'blocked.add', from: '2027-01-10', to: '2027-01-12' }, { cookie });
  await mod.default(noCsrf.req, noCsrf.res);
  assert.equal(noCsrf.res.statusCode, 403);
  /* CSRFヘッダありで受付停止を追加→一覧→削除 */
  const add = makeReqRes('POST', '/api/admin.js?action=blocked.add',
    { action: 'blocked.add', from: '2027-01-10', to: '2027-01-12', reason: 'テスト' },
    { cookie, 'x-requested-with': 'XMLHttpRequest' });
  await mod.default(add.req, add.res);
  assert.equal(add.res.statusCode, 200);
  const list = makeReqRes('GET', '/api/admin.js?action=blocked.list', null, { cookie });
  await mod.default(list.req, list.res);
  assert.ok(list.res.payload.blocked.some((x) => x.date === '2027-01-10'));
  const rm = makeReqRes('POST', '/api/admin.js?action=blocked.remove',
    { action: 'blocked.remove', from: '2027-01-10', to: '2027-01-12' },
    { cookie, 'x-requested-with': 'XMLHttpRequest' });
  await mod.default(rm.req, rm.res);
  assert.equal(rm.res.statusCode, 200);
  /* 誤ったログインは401（試行制限にカウントされるため別ユーザー名） */
  const badLogin = makeReqRes('POST', '/api/admin.js?action=login', { username: 'owner', password: 'wrong' });
  await mod.default(badLogin.req, badLogin.res);
  assert.equal(badLogin.res.statusCode, 401);
});

test('api: admin 手動予約は確定状態で登録・重複は409・analytics集計', async () => {
  process.env.ADMIN_KEY = 'test-admin-key-123';
  process.env.ADMIN_SEED = 'サイト管理者:admin2:testpass123';
  const mod = await import('../api/admin.js');
  const H = { cookie: 'x', 'x-requested-with': 'XMLHttpRequest' };
  const login = makeReqRes('POST', '/api/admin.js?action=login', { username: 'admin2', password: 'testpass123' });
  await mod.default(login.req, login.res);
  H.cookie = login.res.hs['Set-Cookie'].replace(/; .*/, '');
  const mk = makeReqRes('POST', '/api/admin.js?action=booking.manual', {
    action: 'booking.manual',
    checkin: '2027-02-01', checkout: '2027-02-03', adults: 4, infants: 1,
    name: '電話太郎', email: 'tel@example.com', phone: '0773216424',
  }, H);
  await mod.default(mk.req, mk.res);
  assert.equal(mk.res.statusCode, 200);
  assert.equal(mk.res.payload.booking.status, 'confirmed');
  assert.equal(mk.res.payload.booking.price_jpy, 96000); /* 4名2泊=48,000×2 */
  assert.equal(mk.res.payload.booking.onsite_amount, 96000);
  const dup = makeReqRes('POST', '/api/admin.js?action=booking.manual', {
    action: 'booking.manual',
    checkin: '2027-02-02', checkout: '2027-02-04', adults: 2, infants: 0,
    name: 'B', email: 'b@e.com', phone: '0773216424',
  }, H);
  await mod.default(dup.req, dup.res);
  assert.equal(dup.res.statusCode, 409);
  /* analytics */
  const ana = makeReqRes('GET', '/api/admin.js?action=analytics&year=2027', null, H);
  await mod.default(ana.req, ana.res);
  assert.equal(ana.res.statusCode, 200);
  const feb = ana.res.payload.months[1];
  assert.equal(feb.manual, 1);
  assert.equal(feb.onsiteDue, 96000);
  assert.ok(feb.occupancy > 0);
});

test('email: 未設定時はskippedを返す（実通信なし）', async () => {
  const { sendBookingEmails } = await import('../lib/email.js');
  const r = await sendBookingEmails({
    id: 'EN-X', checkin: '2026-12-01', checkout: '2026-12-02', nights: 1,
    adults: 2, infants: 0, guest_name: 'x', guest_email: 'x@example.com',
    guest_phone: '0', options: {}, price_jpy: 48000, price_detail: {}, onsite_amount: 0,
  });
  assert.equal(r.customer.skipped, true);
  assert.equal(r.owner.skipped, true);
});
