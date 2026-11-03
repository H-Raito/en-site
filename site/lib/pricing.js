// 料金・予約条件の単一情報源（サーバー側で最終計算・検証する）
// ★ 重要: 以下の料金は「開発初期案」であり、運営者の正式承認がまだです。
//   本番決済を有効にする前に BOOKING_PAYMENTS_ENABLED=true の設定と、
//   料金・キャンセルポリシーの正式確定が必要（site/BOOKING_SETUP.md 参照）。
export const PRICING = {
  basePricePerNight: 48000,   // 1泊 基本料金（基本人数まで・税込）
  baseGuests: 4,              // 基本料金に含まれる人数
  extraGuestFeePerNight: 6000,// 5名目以降の1名あたり加算（1泊・税込）
  maxGuests: 16,              // 最大宿泊人数（大人+乳幼児の合計）
  maxAdults: 16,
  maxChildren: 5,
  minNights: 1,
  maxNights: 30,
  currency: 'jpy',
  taxIncluded: true,
};

export function perNight(adults) {
  return PRICING.basePricePerNight + PRICING.extraGuestFeePerNight * Math.max(0, adults - PRICING.baseGuests);
}

export function computePrice(adults, nights) {
  const per = perNight(adults);
  const stay = per * Math.max(0, nights);
  return { perNight: per, staySubtotal: stay, optionsTotal: 0, total: stay };
}

/* サーバー側の予約入力検証。戻り値: { ok, nights } | { ok:false, error:コード } */
export function validateBookingInput(input, todayStr) {
  const { checkin, checkout } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(checkin)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(checkout))) {
    return { ok: false, error: 'invalid_date' };
  }
  const nights = nightsBetweenSafe(checkin, checkout);
  if (nights === null) return { ok: false, error: 'invalid_date' };
  if (checkin < todayStr) return { ok: false, error: 'past_checkin' };
  if (nights < PRICING.minNights) return { ok: false, error: 'invalid_stay' };
  if (nights > PRICING.maxNights) return { ok: false, error: 'too_long_stay' };
  const adults = Number(input.adults);
  const children = input.children == null ? 0 : Number(input.children);
  if (!Number.isInteger(adults) || adults < 1 || adults > PRICING.maxAdults) return { ok: false, error: 'invalid_adults' };
  if (!Number.isInteger(children) || children < 0 || children > PRICING.maxChildren) return { ok: false, error: 'invalid_children' };
  if (adults + children > PRICING.maxGuests) return { ok: false, error: 'capacity_exceeded' };
  return { ok: true, nights, adults, children };
}

function nightsBetweenSafe(ci, co) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ci)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(co))) return null;
  const a = new Date(ci + 'T00:00:00Z');
  const b = new Date(co + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  const n = Math.round((b - a) / 86400000);
  return n >= 1 ? n : 0;
}
