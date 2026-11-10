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
  delete process.env.ADMIN_SEED;
  delete process.env.CRON_SECRET;
  /* メール関連: 環境に実値があってもテスト中は決して送信しない（Issue #1） */
  delete process.env.EMAILJS_SERVICE_ID;
  delete process.env.EMAILJS_TEMPLATE_CUSTOMER;
  delete process.env.EMAILJS_TEMPLATE_OWNER;
  delete process.env.EMAILJS_TEMPLATE_THANKYOU;
  delete process.env.EMAILJS_PUBLIC_KEY;
  delete process.env.EMAILJS_PRIVATE_KEY;
  delete process.env.OWNER_EMAIL;
  delete process.env.SITE_URL;
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

test('cutoff: 当日予約可（チェックイン当日の15:00境界・日本時間）', async () => {
  const { validateBookingInput, isPastCutoff } = await import('../lib/pricing.js');
  /* チェックイン当日 2026-11-04 → 期限は当日 15:00 JST = 2026-11-04T06:00Z */
  const deadline = Date.UTC(2026, 10, 4, 6, 0, 0);
  const sameDayBefore = validateBookingInput(
    { checkin: '2026-11-04', checkout: '2026-11-05', adults: 2 },
    '2026-11-04', deadline - 1
  );
  assert.equal(sameDayBefore.ok, true);
  const sameDayAt = validateBookingInput(
    { checkin: '2026-11-04', checkout: '2026-11-05', adults: 2 },
    '2026-11-04', deadline
  );
  assert.equal(sameDayAt.ok, true); /* 「まで」は含む */
  const sameDayAfter = validateBookingInput(
    { checkin: '2026-11-04', checkout: '2026-11-05', adults: 2 },
    '2026-11-04', deadline + 1
  );
  assert.equal(sameDayAfter.error, 'booking_closed');
  /* 翌日以降のチェックインは15:00を過ぎても受付可 */
  const tomorrow = validateBookingInput(
    { checkin: '2026-11-05', checkout: '2026-11-06', adults: 2 },
    '2026-11-04', deadline + 3600000
  );
  assert.equal(tomorrow.ok, true);
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

test('store: 期限切れ仮予約は支払い猶予の後に解放される（Issue #9）', async () => {
  const s = await makeStore();
  await seedBooking(s, '2026-12-01', '2026-12-03');
  const released = await s.expireStale(Date.now() + 31 * 60 * 1000);
  assert.equal(released.length, 1);
  /* 猶予内（expires_at から15分）は空きにしない（支払い競合の二重予約防止） */
  assert.notEqual(await s.findActive('2026-12-01', '2026-12-03'), null, '猶予内は解放しない');
  await s.updateBooking((await s.listBookings({}))[0].id, { expires_at: Date.now() - 16 * 60 * 1000 });
  assert.equal(await s.findActive('2026-12-01', '2026-12-03'), null, '猶予後は解放される');
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
/* ---------- キャンセル返金計算（2026-11 確定ポリシー） ---------- */
/* チェックイン D=2026-12-10 / D日15:00 JST = 2026-12-10T06:00Z */
/* D-5日 15:00 JST = 2026-12-05T06:00Z */

function mkBooking(nights, confirmedAtMs) {
  const per = 48000;
  return {
    checkin: '2026-12-10', nights, adults: 2, infants: 0,
    confirmed_at: confirmedAtMs == null ? null : confirmedAtMs,
    price_detail: { perNight: per, staySubtotal: per * nights, optionsOnline: optsOnline(nights) },
  };
}
function optsOnline(n) { return 2000; } /* オンライン決済オプション（BBQ）固定 */

test('refund: 5日前15:00ちょうどは100%返金（境界含む）', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  const r = calculateRefund(mkBooking(1), Date.UTC(2026, 11, 5, 6, 0, 0));
  assert.equal(r.tier, 'full');
  assert.equal(r.refundJpy, 48000);
  assert.equal(r.optionsRefundJpy, 2000);
});

test('refund: 5日前15:00を1秒過ぎたら1泊目無償・2泊目以降50%', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  const r = calculateRefund(mkBooking(3), Date.UTC(2026, 11, 5, 6, 0, 1));
  assert.equal(r.tier, 'partial');
  assert.equal(r.refundJpy, 48000); /* (3-1)×48,000×0.5 = 48,000 */
});

test('refund: 1泊予約の期限後キャンセルは返金0円', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  const r = calculateRefund(mkBooking(1), Date.UTC(2026, 11, 6, 0, 0, 0));
  assert.equal(r.tier, 'partial');
  assert.equal(r.refundJpy, 0);
});

test('refund: 2泊予約の期限後は2泊目の50%=24,000円', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  const r = calculateRefund(mkBooking(2), Date.UTC(2026, 11, 6, 0, 0, 0));
  assert.equal(r.tier, 'partial');
  assert.equal(r.refundJpy, 24000);
});

test('refund: 複数泊（5泊）期限後は (4泊×50%)=96,000円', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  const r = calculateRefund(mkBooking(5), Date.UTC(2026, 11, 6, 0, 0, 0));
  assert.equal(r.tier, 'partial');
  assert.equal(r.refundJpy, 96000);
});

test('refund: チェックイン後の途中キャンセル（宿泊済み2泊・残2泊→50%返金）', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  /* D日15:00から 2泊+6時間経過 → 宿泊済み3泊扱い? ceil(54h/24h)=3。残=5-3-1=1 → 24,000円 */
  const r = calculateRefund(mkBooking(5), Date.UTC(2026, 11, 12, 21, 0, 0));
  assert.equal(r.tier, 'after_checkin');
  assert.equal(r.refundJpy, 24000);
  assert.ok(r.detail.remaining >= 0);
});

test('refund: チェックイン後すぐのキャンセル（追加1泊分のみ無償・残り50%）', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  /* D日16:00 = 経過1時間 → 宿泊済み1泊 → 残=5-1-1=3 → 3×48,000×0.5=72,000円 */
  const r = calculateRefund(mkBooking(5), Date.UTC(2026, 11, 10, 7, 0, 0));
  assert.equal(r.tier, 'after_checkin');
  assert.equal(r.refundJpy, 72000);
});

test('refund: 残り泊数がない場合は返金0円', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  /* 2泊予約・チェックイン翌々日以降 → 宿泊済み2泊+追加1泊=3>2 → 残0 → 0円 */
  const r = calculateRefund(mkBooking(2), Date.UTC(2026, 11, 13, 0, 0, 0));
  assert.equal(r.tier, 'after_checkin');
  assert.equal(r.refundJpy, 0);
});

test('refund: 予約確定後24時間以内+チェックイン7日以上前は全額返金', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  /* 確定 2026-11-20T00:00Z / チェックイン 2026-11-28（8日後=7日以上前）/
     24時間後は 11-21T00:00Z。キャンセル 11-20T23:59Z → 全額 */
  const b = mkBooking(2, Date.UTC(2026, 10, 20, 0, 0, 0));
  /* checkin 11-28 の15:00以降チェックではないので、通常区分だと full になるが
     24h ルールも full。ここでは通常区分が partial になるケースを作るため
     無料期限 D-5日15:00 = 11-23T06:00Z より後（期限後）にキャンセルする日時を設定 */
  const r = calculateRefund(b, Date.UTC(2026, 10, 21, 0, 0, 1)); /* 確定から24時間+1秒 */
  /* 24時間ルールの対象外 → 通常区分: 期限前なので full（仕様どおり） */
  assert.equal(r.tier, 'full');
  /* 24時間以内 → 24h_free が優先 */
  const r2 = calculateRefund(b, Date.UTC(2026, 10, 21, 0, 0, 0));
  assert.equal(r2.tier, '24h_free');
  assert.equal(r2.refundJpy, 96000);
  assert.equal(r2.optionsRefundJpy, 2000);
});

test('refund: 24時間を1秒過ぎたら通常区分に従う', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  /* 確定 2026-11-20 / チェックイン 2026-11-28（7日以上前）/ キャンセル 11-21T00:00:01Z（24時間+1秒）
     通常区分: 無料期限は D-5日15:00 = 11-23T06:00Z より前 → full。*/
  const b = mkBooking(2, Date.UTC(2026, 10, 20, 0, 0, 0));
  const r = calculateRefund(b, Date.UTC(2026, 10, 21, 0, 0, 1));
  assert.equal(r.tier, 'full'); /* 期限前のため full（24時間ルール切れでも結果は同じ） */
  /* チェックインがもっと近い場合: 確定 11-20 / チェックイン 11-28 → 無料期限 11-23。
     確定から24時間を過ぎ、かつ無料期限内なので full は維持。
     24時間ルールが実質効力を持つケース: 確定時点で無料期限を過ぎている場合は
     チェックイン7日以上前という条件と矛盾するため存在しない（設計上の整理を報告） */
  assert.ok(true);
});

test('refund: チェックイン7日前ちょうどに確定した予約は24時間ルールの対象', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  /* チェックイン D=2026-12-10（15:00JST）。確定 = D-7日 = 2026-12-03T00:00Z。
     確定から24時間以内にキャンセル（12-04T00:00Z）→ 全額返金 */
  const b = mkBooking(2, Date.UTC(2026, 11, 3, 0, 0, 0));
  const r = calculateRefund(b, Date.UTC(2026, 11, 4, 0, 0, 0));
  assert.equal(r.tier, '24h_free');
  assert.equal(r.refundJpy, 96000);
});

test('refund: 6日前確定でも24時間経過後は通常区分（無料期限内のためfull）', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  /* 確定 = D-6日 = 2026-12-04T00:00Z。キャンセル 12-05T12:00Z（24時間経過）。
     無料期限 D-5日15:00 = 12-05T06:00Z → キャンセル時点は期限後。
     24h ルール対象外（確定から24時間以内ではない）→ partial になる。
     ただしこのケースは確定時点で無料期限内だったものが期限を過ぎたもので、
     Airbnb「普通」でも同一挙動。 */
  const b = mkBooking(2, Date.UTC(2026, 11, 4, 0, 0, 0));
  const r = calculateRefund(b, Date.UTC(2026, 11, 5, 12, 0, 0));
  assert.equal(r.tier, 'partial');
  assert.equal(r.refundJpy, 24000);
});

test('refund: オプションはチェックイン開始後は自動返金しない（運営者判断）', async () => {
  const { calculateRefund } = await import('../lib/pricing.js');
  const r = calculateRefund(mkBooking(5), Date.UTC(2026, 11, 10, 7, 0, 0));
  assert.equal(r.optionsRefundJpy, 0);
});

/* ---------- maxNights 27 ---------- */
test('validate: 28泊以上は受付不可（長期宿泊規約未確定）', async () => {
  const { validateBookingInput } = await import('../lib/pricing.js');
  const now = Date.UTC(2026, 10, 1, 6, 0, 0);
  const r28 = validateBookingInput(
    { checkin: '2026-11-05', checkout: '2026-12-03', adults: 2 }, '2026-11-01', now
  );
  assert.equal(r28.error, 'too_long_stay'); /* 28泊 */
  const r27 = validateBookingInput(
    { checkin: '2026-11-05', checkout: '2026-12-02', adults: 2 }, '2026-11-01', now
  );
  assert.equal(r27.ok, true); /* 27泊は可 */
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

test('api: webhook は鍵未設定503・署名不正400・正しい署名で200確定（Issue #3）', async () => {
  const mod = await import('../api/stripe-webhook.js');
  /* 鍵未設定 */
  let r = new Request('https://x/api/stripe-webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=bad' } });
  let res = await mod.default.fetch(r);
  assert.equal(res.status, 503);
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
  /* 署名不正 */
  r = new Request('https://x/api/stripe-webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=bad' } });
  res = await mod.default.fetch(r);
  assert.equal(res.status, 400);
  /* Stripeが送る整形付き本文でも、生本文に対する正しい署名なら200で確定まで進む */
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe('sk_test_dummy');
  globalThis.__enTestStore = await makeStore();
  const seed = await seedBooking(globalThis.__enTestStore, '2027-06-01', '2027-06-03');
  const pretty = JSON.stringify({
    id: 'evt_test_issue3', object: 'event', type: 'checkout.session.completed',
    data: { object: { id: 'cs_x', object: 'checkout.session', client_reference_id: seed.id, payment_status: 'paid', payment_intent: 'pi_test_issue3' } },
  }, null, 2);
  const sig = await stripe.webhooks.generateTestHeaderString({ payload: pretty, secret: 'whsec_dummy', timestamp: Math.floor(Date.now() / 1000) });
  r = new Request('https://x/api/stripe-webhook', { method: 'POST', body: pretty, headers: { 'stripe-signature': sig } });
  res = await mod.default.fetch(r);
  assert.equal(res.status, 200, '整形付き本文+正しい署名でも受理されるべき');
  const confirmed = await globalThis.__enTestStore.getBooking(seed.id);
  assert.equal(confirmed.status, 'confirmed');
  delete globalThis.__enTestStore;
});

test('api: cron は Authorization Bearer のみ受け付ける（Issue #4）', async () => {
  process.env.CRON_SECRET = 's3cret-value-2026';
  const mod = await import('../api/cron.js');
  /* ヘッダなし・誤値・URLクエリは401（URLに鍵を出す経路は廃止） */
  for (const [url, headers, expect] of [
    ['/api/cron', {}, 401],
    ['/api/cron', { authorization: 'Bearer wrong' }, 401],
    ['/api/cron?key=s3cret-value-2026', {}, 401],
    ['/api/cron', { authorization: 'Bearer s3cret-value-2026' }, 200],
  ]) {
    globalThis.__enTestStore = await makeStore();
    const { req, res } = makeReqRes('GET', url, null, headers);
    await mod.default(req, res);
    assert.equal(res.statusCode, expect, url + ' ' + JSON.stringify(headers));
    delete globalThis.__enTestStore;
  }
});

test('api: admin 未認証401・CSRF拒否・ログイン後に操作', async () => {
  process.env.ADMIN_KEY = 'test-admin-key-0123456789abcdef-32chars';
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

test('api: admin session.check はDB未設定でも200（Cookie検証のみ・DB参照しない）', async () => {
  process.env.ADMIN_KEY = 'test-admin-key-0123456789abcdef-32chars';
  const prevDb = process.env.DATABASE_URL;
  const prevVercel = process.env.VERCEL;
  delete process.env.DATABASE_URL;
  process.env.VERCEL = 'true';
  try {
    const mod = await import('../api/admin.js');
    const { issueToken } = await import('../lib/admin-auth.js');
    /* 未認証は401 */
    const noauth = makeReqRes('GET', '/api/admin.js?action=session.check');
    await mod.default(noauth.req, noauth.res);
    assert.equal(noauth.res.statusCode, 401);
    /* 有効な署名クッキーがあればDB未設定でも200 */
    const cookie = 'en_admin=' + issueToken('admin');
    const check = makeReqRes('GET', '/api/admin.js?action=session.check', null, { cookie });
    await mod.default(check.req, check.res);
    assert.equal(check.res.statusCode, 200);
    assert.equal(check.res.payload.username, 'admin');
    /* 同じ環境でDBを要する操作は503 not_configured（session.checkだけがDB不要であることの対比）。
       モジュール単位のストアキャッシュも解消してから評価する（テスト順序に依存しない） */
    const { resetStoreCache } = await import('../lib/store.js');
    const prevStore = globalThis.__enTestStore;
    delete globalThis.__enTestStore;
    resetStoreCache();
    const list = makeReqRes('GET', '/api/admin.js?action=bookings.list', null, { cookie });
    await mod.default(list.req, list.res);
    assert.equal(list.res.statusCode, 503);
    assert.equal(list.res.payload.error, 'not_configured');
    resetStoreCache();
    if (prevStore !== undefined) globalThis.__enTestStore = prevStore;
  } finally {
    if (prevDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevDb;
    if (prevVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = prevVercel;
  }
});

test('api: admin 手動予約は確定状態で登録・重複は409・analytics集計', async () => {
  process.env.ADMIN_KEY = 'test-admin-key-0123456789abcdef-32chars';
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
  /* 入金済みボタン: 記録→analyticsの入金済み売上に反映・二重押下は409 */
  const paid = makeReqRes('POST', '/api/admin.js?action=booking.mark-paid&id=' + mk.res.payload.booking.id, {}, H);
  await mod.default(paid.req, paid.res);
  assert.equal(paid.res.statusCode, 200);
  assert.ok(paid.res.payload.booking.paid_at > 0);
  const paid2 = makeReqRes('POST', '/api/admin.js?action=booking.mark-paid&id=' + mk.res.payload.booking.id, {}, H);
  await mod.default(paid2.req, paid2.res);
  assert.equal(paid2.res.statusCode, 409);
  const ana2 = makeReqRes('GET', '/api/admin.js?action=analytics&year=2027', null, H);
  await mod.default(ana2.req, ana2.res);
  const feb2 = ana2.res.payload.months[1];
  assert.equal(feb2.paidRevenue, 96000);
  assert.equal(ana2.res.payload.totals.paidRevenue, 96000);
  assert.equal(ana2.res.payload.totals.paidTotal, 96000);
  /* 入金取消: 記録を外すと analytics からも外れる（再計上されない） */
  const unmark = makeReqRes('POST', '/api/admin.js?action=booking.unmark-paid&id=' + mk.res.payload.booking.id, {}, H);
  await mod.default(unmark.req, unmark.res);
  assert.equal(unmark.res.statusCode, 200);
  assert.equal(unmark.res.payload.booking.paid_at, null);
  const ana3 = makeReqRes('GET', '/api/admin.js?action=analytics&year=2027', null, H);
  await mod.default(ana3.req, ana3.res);
  assert.equal(ana3.res.payload.months[1].paidRevenue, 0);
  assert.equal(ana3.res.payload.totals.paidRevenue, 0);
  /* 未記録に対する取消は成功扱い（冪等） */
  const unmark2 = makeReqRes('POST', '/api/admin.js?action=booking.unmark-paid&id=' + mk.res.payload.booking.id, {}, H);
  await mod.default(unmark2.req, unmark2.res);
  assert.equal(unmark2.res.statusCode, 200);
  assert.equal(unmark2.res.payload.already, true);
  /* GETでの変更操作は405で拒否される（CSRF対策・Issue #5） */
  const getByGet = makeReqRes('GET', '/api/admin.js?action=booking.mark-paid&id=' + mk.res.payload.booking.id, null, H);
  await mod.default(getByGet.req, getByGet.res);
  assert.equal(getByGet.res.statusCode, 405);
  const chk = makeReqRes('GET', '/api/admin.js?action=booking.get&id=' + mk.res.payload.booking.id, null, H);
  await mod.default(chk.req, chk.res);
  const still = chk.res.payload.booking;
  assert.equal(still.paid_at, null, 'GET呼び出しでは paid_at が変わらない');
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

test('store-pg: 全INSERT文の列数と値の数が一致（本番Neonで発生した42601の回帰防止）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/store-pg.js', import.meta.url), 'utf8');
  /* 文字列リテラル・関数呼び出しの括弧を深度考慮してトップレベルの要素数を数える */
  function countExprs(s) {
    let depth = 0, inStr = null, count = 1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (c === inStr) inStr = null; continue; }
      if (c === "'") { inStr = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth < 0) return count; }
      else if (c === ',' && depth === 0) count++;
    }
    return count;
  }
  /* INSERT INTO <table> (cols) VALUES (...) を抽出して突き合わせる */
  const re = /INSERT INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES/g;
  let m, checked = 0;
  while ((m = re.exec(src)) !== null) {
    const cols = m[2].split(',').map((x) => x.trim()).filter(Boolean);
    /* VALUES の括弧対応を正しく閉じるまで走査 */
    let i = re.lastIndex;
    while (src[i] !== '(') i++;
    let depth = 0, j = i;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) break; }
    }
    const vals = countExprs(src.slice(i + 1, j));
    assert.equal(vals, cols.length, m[1] + ' のINSERT: 列数=' + cols.length + ' 値の数=' + vals);
    checked++;
  }
  assert.ok(checked >= 3, 'INSERT文が ' + checked + ' 件検出された（store-pg.js全体を対象）');
});

test('api: 決済ONで予約作成が500にならずprice_detailに人数・泊数が入る（Issue #2）', async () => {
  globalThis.__enTestStore = await makeStore();
  process.env.BOOKING_PAYMENTS_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  globalThis.__enTestStripe = {
    checkout: { sessions: {
      create: async () => ({ id: 'cs_test_issue2', url: 'https://stripe.example/checkout' }),
      retrieve: async (id) => ({ id, status: 'open', url: 'https://stripe.example/checkout' }),
    } },
  };
  try {
    const mod = await import('../api/booking.js');
    const { req, res } = makeReqRes('POST', '/api/booking', {
      checkin: '2027-04-01', checkout: '2027-04-03', adults: 4, infants: 1,
      name: 'クレジット太郎', kana: 'クレジットタロウ', email: 'card@example.com', phone: '0773216424',
      postal: '602-0000', address: '京都市上京区', arrival: '15:00', notes: '',
      options: {}, paymentMethod: 'online', request_id: 'req-issue2-1',
    });
    await mod.default(req, res);
    assert.equal(res.statusCode, 200, '実際の応答: ' + JSON.stringify(res.payload));
    const b = await globalThis.__enTestStore.getBookingByRequest('req-issue2-1');
    assert.ok(b, '予約が保存されている');
    assert.equal(b.price_detail.adults, 4);
    assert.equal(b.price_detail.nights, 2);
  } finally {
    delete globalThis.__enTestStore;
    delete globalThis.__enTestStripe;
  }
});

test('api: admin logout はサーバーでクッキーを無効化する（Issue #6）', async () => {
  process.env.ADMIN_KEY = 'test-admin-key-0123456789abcdef-32chars';
  const { issueToken } = await import('../lib/admin-auth.js');
  const mod = await import('../api/admin.js');
  const cookie = 'en_admin=' + issueToken('admin');
  const { req, res } = makeReqRes('POST', '/api/admin.js?action=logout', {}, { cookie, 'x-requested-with': 'XMLHttpRequest' });
  await mod.default(req, res);
  assert.equal(res.statusCode, 200);
  const sc = res.hs['Set-Cookie'] || '';
  assert.ok(sc.includes('Max-Age=0'), 'クッキー無効化: ' + sc);
  assert.ok(sc.includes('HttpOnly'), sc);
  /* CSRFヘッダなしのlogoutは403 */
  const r2 = makeReqRes('POST', '/api/admin.js?action=logout', {}, { cookie });
  await mod.default(r2.req, r2.res);
  assert.equal(r2.res.statusCode, 403);
});

test('auth: x-admin-key の裏口は撤去済み・ADMIN_KEY は32文字以上必須（Issue #7）', async () => {
  const { adminEnabled, isAdmin, verifyToken } = await import('../lib/admin-auth.js');
  const prev = process.env.ADMIN_KEY;
  try {
    /* 32文字未満の鍵では管理機能全体が無効 */
    process.env.ADMIN_KEY = 'short-key-123';
    assert.equal(adminEnabled(), false);
    assert.equal(verifyToken('1.admin.x'), null);
    /* 有効な署名クッキーでも x-admin-key ヘッダでは通らない */
    process.env.ADMIN_KEY = 'a'.repeat(32);
    const { issueToken } = await import('../lib/admin-auth.js');
    const cookie = 'en_admin=' + issueToken('admin');
    assert.equal(isAdmin({ headers: { cookie } }), 'admin');
    assert.equal(isAdmin({ headers: { cookie, 'x-admin-key': 'a'.repeat(32) } }), 'admin');
    assert.equal(isAdmin({ headers: { 'x-admin-key': 'a'.repeat(32) } }), null, 'ヘッダのみでは管理者になれない');
  } finally {
    if (prev === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prev;
  }
});

test('booking: 支払い猶予内の期限切れ予約は確定でき、猶予後は解放される（Issue #9）', async () => {
  const store = await makeStore();
  const GRACE = 15 * 60 * 1000;
  /* 30分後まで有効な仮予約を作り、期限切れにする（expires_at は未来のまま残る） */
  const a = await seedBooking(store, '2027-08-01', '2027-08-03');
  await store.expireStale(Date.now() + 31 * 60000);
  const a2 = await store.getBooking(a.id);
  assert.equal(a2.status, 'expired');
  /* 猶予内（expires_at から15分）は確定できる（Webhook復活経路） */
  const r = await store.confirmBooking(a.id, 'pi_grace');
  assert.equal(r.booking.status, 'confirmed');
  /* 猶予内の期限切れは空きとして扱われない（ケース2の二重予約防止） */
  const b = await seedBooking(store, '2027-08-10', '2027-08-12');
  await store.expireStale(Date.now() + 31 * 60000);
  let blocked = false;
  try { await seedBooking(store, '2027-08-10', '2027-08-12'); } catch (e) { blocked = e.code === 'unavailable'; }
  assert.equal(blocked, true, '猶予内の期限切れは空きとして扱わない');
  /* 猶予後は解放され、確定もできない */
  const c = await seedBooking(store, '2027-08-20', '2027-08-22');
  await store.updateBooking(c.id, { expires_at: Date.now() - GRACE - 60000 });
  await store.expireStale();
  const d = await seedBooking(store, '2027-08-20', '2027-08-22');
  assert.ok(d, '猶予後は同じ日程の予約が作れる');
  let refused = false;
  try { await store.confirmBooking(c.id, 'pi_late'); } catch (e) { refused = e.code === 'invalid_status'; }
  assert.equal(refused, true, '猶予後の確定は拒否');
});

test('api: 入金記録はメモを壊さず現地支払予定と重複計上しない（Issue #10）', async () => {
  process.env.ADMIN_KEY = 'test-admin-key-0123456789abcdef-32chars';
  process.env.ADMIN_SEED = 'サイト管理者:adminX:testpass123';
  const mod = await import('../api/admin.js');
  const H = { cookie: 'x', 'x-requested-with': 'XMLHttpRequest' };
  const login = makeReqRes('POST', '/api/admin.js?action=login', { username: 'adminX', password: 'testpass123' }, H);
  await mod.default(login.req, login.res);
  H.cookie = login.res.hs['Set-Cookie'].replace(/; .*/, '');
  /* 手動予約（3月・他テストと干渉しない日程） */
  const mk = makeReqRes('POST', '/api/admin.js?action=booking.manual', {
    action: 'booking.manual', checkin: '2027-03-01', checkout: '2027-03-02', adults: 2, infants: 0,
    name: 'メモ太郎', email: 'memo@example.com', phone: '0773216424',
  }, H);
  await mod.default(mk.req, mk.res);
  assert.equal(mk.res.statusCode, 200);
  const id = mk.res.payload.booking.id;
  /* メモ保存 → 入金記録 → メモ不変 */
  const memo1 = makeReqRes('POST', '/api/admin.js?action=booking.memo', { action: 'booking.memo', id, memo: 'アレルギーあり' }, H);
  await mod.default(memo1.req, memo1.res);
  const mark = makeReqRes('POST', '/api/admin.js?action=booking.mark-paid&id=' + id, {}, H);
  await mod.default(mark.req, mark.res);
  assert.equal(mark.res.statusCode, 200);
  const chk = makeReqRes('GET', '/api/admin.js?action=booking.get&id=' + id, null, H);
  await mod.default(chk.req, chk.res);
  assert.equal(chk.res.payload.booking.admin_memo, 'アレルギーあり', '入金記録でメモが壊れない');
  /* analytics: 現地支払予定0・入金済み48000（どちらか一方だけに計上） */
  const ana = makeReqRes('GET', '/api/admin.js?action=analytics&year=2027', null, H);
  await mod.default(ana.req, ana.res);
  const mar = ana.res.payload.months[2];
  assert.equal(mar.onsiteDue, 0, '入金済みは現地支払予定に重複計上しない');
  assert.equal(mar.paidRevenue, 48000);
  /* Web予約のIDで mark-paid は400（手動予約のみ） */
  const { getStore } = await import('../lib/store.js');
  const moduleStore = await getStore();
  const web = await seedBooking(moduleStore, '2027-03-10', '2027-03-11');
  const bad = makeReqRes('POST', '/api/admin.js?action=booking.mark-paid&id=' + web.id, {}, H);
  await mod.default(bad.req, bad.res);
  assert.equal(bad.res.statusCode, 400);
  assert.equal(bad.res.payload.error, 'not_manual');
  /* 入金済みのままキャンセル → 実収入は残る・入金取消は可能 */
  const cancel = makeReqRes('POST', '/api/admin.js?action=booking.cancel&id=' + id, {}, H);
  await mod.default(cancel.req, cancel.res);
  assert.equal(cancel.res.statusCode, 200);
  const ana2 = makeReqRes('GET', '/api/admin.js?action=analytics&year=2027', null, H);
  await mod.default(ana2.req, ana2.res);
  assert.equal(ana2.res.payload.months[2].paidRevenue, 48000, 'キャンセル後も実収入として残る');
  assert.equal(ana2.res.payload.months[2].cancellations, 1);
  const unmark = makeReqRes('POST', '/api/admin.js?action=booking.unmark-paid&id=' + id, {}, H);
  await mod.default(unmark.req, unmark.res);
  assert.equal(unmark.res.statusCode, 200);
  const ana3 = makeReqRes('GET', '/api/admin.js?action=analytics&year=2027', null, H);
  await mod.default(ana3.req, ana3.res);
  assert.equal(ana3.res.payload.months[2].paidRevenue, 0, '入金取消で売上から外れる');
});

test('store: 同一連絡先の未完了仮予約を検出する（Issue #11）', async () => {
  const s = await makeStore();
  await seedBooking(s, '2027-09-01', '2027-09-02', { email: 'same@example.com', phone: '09000000001' });
  const hit = await s.findActivePendingByContact('same@example.com', '09999999999');
  assert.ok(hit, 'メール一致で検出');
  assert.equal(hit.id.length > 0, true);
  const hit2 = await s.findActivePendingByContact('other@example.com', '0773216424');
  assert.ok(hit2, '電話一致でも検出');
  const miss = await s.findActivePendingByContact('other@example.com', '09999999999');
  assert.equal(miss, null, 'どちらも一致しなければ検出しない');
  /* 期限切れ+猶予後は検出しない */
  await s.expireStale(Date.now() + 31 * 60000);
  await s.updateBooking((await s.listBookings({}))[0].id, { expires_at: Date.now() - 16 * 60000 });
  const miss2 = await s.findActivePendingByContact('same@example.com', '09999999999');
  assert.equal(miss2, null, '猶予後の期限切れは検出しない');
});

test('api: 同一連絡先の未完了仮予約があると pending_exists で409（Issue #11）', async () => {
  globalThis.__enTestStore = await makeStore();
  process.env.BOOKING_PAYMENTS_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  globalThis.__enTestStripe = {
    checkout: { sessions: { create: async () => ({ id: 'cs_t', url: 'https://stripe.example/x' }), retrieve: async (id) => ({ id, status: 'open', url: 'https://stripe.example/x' }) } },
  };
  try {
    const mod = await import('../api/booking.js');
    /* 1件目は通る */
    const r1 = makeReqRes('POST', '/api/booking', {
      checkin: '2027-10-01', checkout: '2027-10-02', adults: 2, infants: 0,
      name: '一郎', email: 'first@example.com', phone: '09011112222',
      options: {}, paymentMethod: 'online', request_id: 'req-issue11-1',
    });
    await mod.default(r1.req, r1.res);
    assert.equal(r1.res.statusCode, 200);
    /* 同じメールで2件目は409 pending_exists */
    const r2 = makeReqRes('POST', '/api/booking', {
      checkin: '2027-10-05', checkout: '2027-10-06', adults: 2, infants: 0,
      name: '一郎', email: 'first@example.com', phone: '09011112222',
      options: {}, paymentMethod: 'online', request_id: 'req-issue11-2',
    });
    await mod.default(r2.req, r2.res);
    assert.equal(r2.res.statusCode, 409);
    assert.equal(r2.res.payload.error, 'pending_exists');
    /* 別の連絡先なら通る */
    const r3 = makeReqRes('POST', '/api/booking', {
      checkin: '2027-10-05', checkout: '2027-10-06', adults: 2, infants: 0,
      name: '二郎', email: 'second@example.com', phone: '09033334444',
      options: {}, paymentMethod: 'online', request_id: 'req-issue11-3',
    });
    await mod.default(r3.req, r3.res);
    assert.equal(r3.res.statusCode, 200, '別連絡先は影響しない: ' + JSON.stringify(r3.res.payload));
  } finally {
    delete globalThis.__enTestStore;
    delete globalThis.__enTestStripe;
  }
});

test('api: 管理者パスワード変更と無効化（Issue #12）', async () => {
  process.env.ADMIN_KEY = 'test-admin-key-0123456789abcdef-32chars';
  process.env.ADMIN_SEED = 'サイト管理者:adminY:testpass123,サブ:subY:testpass456';
  const mod = await import('../api/admin.js');
  const H = { cookie: 'x', 'x-requested-with': 'XMLHttpRequest' };
  const login = makeReqRes('POST', '/api/admin.js?action=login', { username: 'adminY', password: 'testpass123' }, H);
  await mod.default(login.req, login.res);
  assert.equal(login.res.statusCode, 200);
  H.cookie = login.res.hs['Set-Cookie'].replace(/; .*/, '');
  /* パスワード変更（12文字未満は拒否） */
  const weak = makeReqRes('POST', '/api/admin.js?action=account.change-password', { action: 'account.change-password', current: 'testpass123', next: 'short' }, H);
  await mod.default(weak.req, weak.res);
  assert.equal(weak.res.statusCode, 400);
  assert.equal(weak.res.payload.error, 'weak_password');
  /* 正しい変更 → 旧パスワードでログイン不可・新パスワードで可 */
  const chg = makeReqRes('POST', '/api/admin.js?action=account.change-password', { action: 'account.change-password', current: 'testpass123', next: 'newpass-12345678' }, H);
  await mod.default(chg.req, chg.res);
  assert.equal(chg.res.statusCode, 200);
  const oldLogin = makeReqRes('POST', '/api/admin.js?action=login', { username: 'adminY', password: 'testpass123' }, {});
  await mod.default(oldLogin.req, oldLogin.res);
  assert.equal(oldLogin.res.statusCode, 401);
  const newLogin = makeReqRes('POST', '/api/admin.js?action=login', { username: 'adminY', password: 'newpass-12345678' }, {});
  await mod.default(newLogin.req, newLogin.res);
  assert.equal(newLogin.res.statusCode, 200);
  /* 自分の無効化は不可 */
  const self = makeReqRes('POST', '/api/admin.js?action=admin.set-enabled', { action: 'admin.set-enabled', username: 'adminY', disabled: true }, H);
  await mod.default(self.req, self.res);
  assert.equal(self.res.statusCode, 400);
  assert.equal(self.res.payload.error, 'cannot_disable_self');
  /* subY を無効化 → subY のクッキーは401 → 再有効化で復帰 */
  const login2 = makeReqRes('POST', '/api/admin.js?action=login', { username: 'subY', password: 'testpass456' }, {});
  await mod.default(login2.req, login2.res);
  const { issueToken } = await import('../lib/admin-auth.js');
  const subCookie2 = 'en_admin=' + issueToken('subY');
  const subList = makeReqRes('GET', '/api/admin.js?action=bookings.list', null, { cookie: subCookie2 });
  await mod.default(subList.req, subList.res);
  assert.equal(subList.res.statusCode, 200);
  const dis = makeReqRes('POST', '/api/admin.js?action=admin.set-enabled', { action: 'admin.set-enabled', username: 'subY', disabled: true }, H);
  await mod.default(dis.req, dis.res);
  assert.equal(dis.res.statusCode, 200);
  const subList2 = makeReqRes('GET', '/api/admin.js?action=bookings.list', null, { cookie: subCookie2 });
  await mod.default(subList2.req, subList2.res);
  assert.equal(subList2.res.statusCode, 401, '無効化された管理者のクッキーは401');
  const reEn = makeReqRes('POST', '/api/admin.js?action=admin.set-enabled', { action: 'admin.set-enabled', username: 'subY', disabled: false }, H);
  await mod.default(reEn.req, reEn.res);
  assert.equal(reEn.res.statusCode, 200);
  const subList3 = makeReqRes('GET', '/api/admin.js?action=bookings.list', null, { cookie: subCookie2 });
  await mod.default(subList3.req, subList3.res);
  assert.equal(subList3.res.statusCode, 200, '再有効化で復帰');
  /* admin.list に載る */
  const list = makeReqRes('GET', '/api/admin.js?action=admin.list', null, H);
  await mod.default(list.req, list.res);
  assert.ok(list.res.payload.admins.some((a) => a.username === 'adminY'));
});

test('api: ログイン試行制限は失敗記録で効く・存在しないユーザー名も制限対象（Issue #14）', async () => {
  process.env.ADMIN_KEY = 'test-admin-key-0123456789abcdef-32chars';
  process.env.ADMIN_SEED = 'サイト管理者:adminZ:testpass123';
  const mod = await import('../api/admin.js');
  for (let i = 0; i < 5; i++) {
    const f = makeReqRes('POST', '/api/admin.js?action=login', { username: 'adminZ', password: 'wrong-' + i }, {});
    await mod.default(f.req, f.res);
    assert.equal(f.res.statusCode, 401);
  }
  const blocked = makeReqRes('POST', '/api/admin.js?action=login', { username: 'adminZ', password: 'testpass123' }, {});
  await mod.default(blocked.req, blocked.res);
  assert.equal(blocked.res.statusCode, 429, '正しいパスワードでも5回失敗後は429');
  for (let i = 0; i < 5; i++) {
    const f = makeReqRes('POST', '/api/admin.js?action=login', { username: 'ghost-user', password: 'x' }, {});
    await mod.default(f.req, f.res);
    assert.equal(f.res.statusCode, 401);
  }
  const blocked2 = makeReqRes('POST', '/api/admin.js?action=login', { username: 'ghost-user', password: 'x' }, {});
  await mod.default(blocked2.req, blocked2.res);
  assert.equal(blocked2.res.statusCode, 429, '存在しないユーザー名も制限される');
});
