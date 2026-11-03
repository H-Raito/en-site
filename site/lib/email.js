// 予約メール送信（EmailJS REST API・サーバー側から送信）。
// ブラウザ側に依存しない。環境変数未設定なら skipped を返す（送信停止・設定はBOOKING_SETUP.md）。
import { PRICING } from './pricing.js';

const REST_URL = 'https://api.emailjs.com/api/v1.0/email/send';

export function emailConfig() {
  return {
    serviceId: process.env.EMAILJS_SERVICE_ID,
    customerTemplateId: process.env.EMAILJS_TEMPLATE_CUSTOMER,
    ownerTemplateId: process.env.EMAILJS_TEMPLATE_OWNER,
    publicKey: process.env.EMAILJS_PUBLIC_KEY,
    privateKey: process.env.EMAILJS_PRIVATE_KEY || '',
    ownerEmail: process.env.OWNER_EMAIL || '',
  };
}

export function emailConfigured(cfg) {
  return !!(cfg.serviceId && cfg.customerTemplateId && cfg.ownerTemplateId && cfg.publicKey);
}

async function send(cfg, templateId, params) {
  const body = {
    service_id: cfg.serviceId,
    template_id: templateId,
    user_id: cfg.publicKey,
    template_params: params,
  };
  if (cfg.privateKey) body.accessToken = cfg.privateKey;
  try {
    const res = await fetch(REST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const errorText = res.ok ? '' : (await res.text()).slice(0, 300);
    return { ok: res.ok, status: res.status, errorText };
  } catch (e) {
    return { ok: false, status: 0, errorText: String(e && e.message ? e.message : e) };
  }
}

function yen(n) {
  return Number(n || 0).toLocaleString('ja-JP');
}

/* EmailJS は 1リクエスト/秒 のため2通目の前に待つ */
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function sendBookingEmails(booking) {
  const cfg = emailConfig();
  if (!emailConfigured(cfg)) {
    return { customer: { ok: false, skipped: true }, owner: { ok: false, skipped: true } };
  }
  const b = booking;
  const opts = b.options || {};
  const optText = [
    opts.bbq ? 'BBQセット（希望・当日現金払い）' : null,
    opts.sauna ? 'テントサウナ（希望・当日現金払い）' : null,
    opts.earlyCheckin ? 'アーリーチェックイン12:00（希望・当日現金払い5,000円）' : null,
  ].filter(Boolean).join(' / ') || 'なし';

  const base = {
    booking_id: b.id,
    guest_name: b.guest_name,
    guest_kana: b.guest_kana || '',
    guest_email: b.guest_email,
    guest_phone: b.guest_phone,
    guest_address: b.guest_address || '',
    checkin: b.checkin,
    checkout: b.checkout,
    nights: String(b.nights),
    adults: String(b.adults),
    children: String(b.children || 0),
    arrival_time: b.arrival_time || '',
    notes: b.notes || 'なし',
    options: optText,
    per_night: yen(b.price_detail && b.price_detail.perNight),
    subtotal: yen(b.price_jpy),
    total: yen(b.price_jpy) + (PRICING.taxIncluded ? '（税込）' : ''),
    online_paid: yen(b.online_total != null ? b.online_total : b.price_jpy) + '（オンライン決済済み）',
    onsite_due: yen(b.onsite_amount || 0) + '（当日現金支払予定' + (b.options && b.options.earlyCheckin ? '・アーリーチェックインは承認後に確定' : '') + '）',
    payment_method: b.payment_method === 'onsite' ? '宿泊料のみオンライン決済・オプション現地払い' : '宿泊料とオプションをまとめてオンライン決済',
    checkin_time: '15:00〜22:00',
    checkout_time: '〜12:00',
    facility_address: '京都府福知山市観音寺131-1',
    facility_tel: '0773-21-6424',
  };
  const toOwner = { ...base, owner_email: cfg.ownerEmail || '' };

  const customer = await send(cfg, cfg.customerTemplateId, { ...base, to_email: b.guest_email });
  await wait(1100);
  const owner = await send(cfg, cfg.ownerTemplateId, { ...toOwner, to_email: cfg.ownerEmail || '' });
  return { customer, owner };
}


/* チェックアウト翌日のお礼メール（宣伝色を抑えた自然な一文） */
export async function sendThankYou(booking) {
  const cfg = emailConfig();
  if (!emailConfigured(cfg)) return { ok: false, skipped: true };
  const params = {
    to_email: booking.guest_email,
    guest_name: booking.guest_name,
    checkin: booking.checkin,
    checkout: booking.checkout,
    facility_name: 'EN',
    facility_tel: '0773-21-6424',
    facility_address: '京都府福知山市観音寺131-1',
  };
  return send(cfg, cfg.thankyouTemplateId || process.env.EMAILJS_TEMPLATE_THANKYOU, params);
}