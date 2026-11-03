// ============================================================
// 料金・予約条件の単一情報源（2026-11 確定版・運営者承認済み）
// 金額はすべて税込。宿泊夜は半開区間 [checkin, checkout) で管理。
// ============================================================

export const PRICING = {
  basePricePerNight: 48000,    // 1泊 基本料金（基本人数まで・税込）
  baseGuests: 4,               // 基本料金に含まれる人数
  extraGuestFeePerNight: 6000, // 5名目から1名につき加算（1泊・税込）
  maxPaidGuests: 16,           // 有料宿泊人数の上限（3歳以上）
  maxInfants: 5,               // 2歳以下（無料・寝具アメニティなし）の受付上限
  minNights: 1,
  maxNights: 30,
  bookingCutoffDays: 3,        // 予約受付期限: チェックイン3日前の15:00まで
  options: {
    bbq: 2000,                 // 1予約につき（泊数倍しない）
    sauna: 2000,               // 1予約につき
    earlyCheckin: 5000,        // 希望受付・承認制（予約時は徴収しない）
  },
  currency: 'jpy',
  taxIncluded: true,
};

/* 3歳以上（有料）の人数から1泊料金を算出 */
export function perNight(adults) {
  return PRICING.basePricePerNight + PRICING.extraGuestFeePerNight * Math.max(0, adults - PRICING.baseGuests);
}

/*
 * 料金計算。
 * adults: 3歳以上の有料人数 / infants: 2歳以下（無料）
 * paymentMethod: 'online' = 宿泊+オプションをまとめてStripe決済
 *                'onsite'  = 宿泊のみStripe決済・オプションは現地現金払い
 * アーリーチェックインは希望受記録のみ（承認制のため予約時に徴収しない）。
 * 戻り値: { perNight, staySubtotal, optionsOnline, optionsOnsite, onlineTotal, onsiteAmount }
 */
export function computePrice(adults, nights, options = {}, paymentMethod = 'online') {
  const per = perNight(adults);
  const stay = per * Math.max(0, nights);
  const bbq = options.bbq ? PRICING.options.bbq : 0;
  const sauna = options.sauna ? PRICING.options.sauna : 0;
  const early = options.earlyCheckin ? PRICING.options.earlyCheckin : 0;
  const optionsOnline = paymentMethod === 'online' ? bbq + sauna : 0;
  const optionsOnsite = bbq + sauna - optionsOnline + early;
  return {
    perNight: per,
    staySubtotal: stay,
    optionsOnline,
    optionsOnsite,
    onlineTotal: stay + optionsOnline,
    onsiteAmount: optionsOnsite,
  };
}

/*
 * 予約入力の検証（サーバー最終防壁）。
 * adults: 3歳以上 / infants: 2歳以下。実人数（adults+infants）が16名を超える予約は確定させない。
 * todayStr / nowMs: 日本時間基準。テストから注入可能。
 * 戻り値: { ok, nights, adults, infants } | { ok:false, error:コード }
 */
export function validateBookingInput(input, todayStr, nowMs = Date.now()) {
  const ci = String(input.checkin || '');
  const co = String(input.checkout || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ci) || !/^\d{4}-\d{2}-\d{2}$/.test(co)) return { ok: false, error: 'invalid_date' };
  const a = new Date(ci + 'T00:00:00Z');
  const b = new Date(co + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return { ok: false, error: 'invalid_date' };
  const nights = Math.round((b - a) / 86400000);
  if (ci < todayStr) return { ok: false, error: 'past_checkin' };
  if (nights < PRICING.minNights) return { ok: false, error: 'invalid_stay' };
  if (nights > PRICING.maxNights) return { ok: false, error: 'too_long_stay' };

  /* 予約受付期限: チェックイン3日前の15:00（日本時間）まで */
  if (isPastCutoff(ci, nowMs)) return { ok: false, error: 'booking_closed' };

  const adults = Number(input.adults);
  const infants = input.infants == null ? 0 : Number(input.infants);
  if (!Number.isInteger(adults) || adults < 1 || adults > PRICING.maxPaidGuests) return { ok: false, error: 'invalid_adults' };
  if (!Number.isInteger(infants) || infants < 0 || infants > PRICING.maxInfants) return { ok: false, error: 'invalid_infants' };
  /* 実人数（3歳以上+2歳以下）の安全上限 */
  if (adults + infants > PRICING.maxPaidGuests) return { ok: false, error: 'capacity_exceeded' };
  const pm = input.paymentMethod;
  if (pm != null && pm !== 'online' && pm !== 'onsite') return { ok: false, error: 'invalid_payment_method' };
  return { ok: true, nights, adults, infants };
}

/* チェックイン日 D の 15:00 JST = UTC 06:00。期限 = D-3日の15:00 JST。期限を過ぎたら true */
export function isPastCutoff(checkin, nowMs = Date.now()) {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(checkin || ''));
  if (!p) return true;
  const checkinDeadline = Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3]), 6, 0, 0); /* D日 15:00 JST */
  const cutoff = checkinDeadline - PRICING.bookingCutoffDays * 86400000;
  return nowMs > cutoff;
}

/*
 * キャンセル返金額の計算（サーバー側・日本時間基準）。
 * 区分（チェックイン予定日 D の 15:00 JST を基準）:
 *   now <= D-5日 15:00 JST        → 宿泊料金100%返金
 *   その後〜 D日 15:00 JST 未満    → 1泊目返金なし、2泊目以降は50%返金
 *   D日 15:00 JST 以降            → 返金なし（案・運営者承認待ちとして管理画面に表示）
 * オプションはオンライン決済分のみ全額返金対象（未提供のため）。現地払い分はStripe返金しない。
 * 戻り値: { tier, refundJpy, optionsRefundJpy }
 */
export function calculateRefund(booking, nowMs = Date.now()) {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(booking.checkin || '');
  if (!p) return { tier: 'unknown', refundJpy: 0, optionsRefundJpy: 0 };
  const checkin15 = Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3]), 6, 0, 0);
  const freeUntil = checkin15 - 5 * 86400000;
  const per = booking.price_detail && booking.price_detail.perNight ? booking.price_detail.perNight : perNight(booking.adults);
  const nights = booking.nights || 1;
  let tier;
  let stayRefund;
  if (nowMs <= freeUntil) {
    tier = 'full';
    stayRefund = booking.price_detail && booking.price_detail.staySubtotal ? booking.price_detail.staySubtotal : per * nights;
  } else if (nowMs < checkin15) {
    tier = 'partial';
    stayRefund = Math.round(per * Math.max(0, nights - 1) * 0.5);
  } else {
    tier = 'none';
    stayRefund = 0;
  }
  const optionsOnline = booking.price_detail && booking.price_detail.optionsOnline ? booking.price_detail.optionsOnline : 0;
  return { tier, refundJpy: stayRefund, optionsRefundJpy: optionsOnline };
}

/* 料金内訳の表示用 */
export function describePrice(p, adults, nights) {
  return {
    perNightLabel: '¥' + per.toLocaleString('ja-JP') + ' / 泊',
    nightsLabel: nights + '泊',
    stayLabel: '¥' + p.staySubtotal.toLocaleString('ja-JP'),
  };
}
