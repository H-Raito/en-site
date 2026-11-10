// 定期メンテナンス: 期限切れ仮予約の解放と、失敗した予約メールの再送。
// Vercel Cron（1日1回）+ 予約作成・照会時の遅延実行で二重に動く。CRON_SECRETで保護。
import { getStore } from '../lib/store.js';
import { confirmAndNotify } from '../lib/confirm.js';
import { tokyoToday, eachNight } from '../lib/util.js';
import { emailConfigured, emailConfig } from '../lib/email.js';
import { timingSafeEqual } from 'node:crypto';

/* 長さ違いでも例外を出さないタイミング安全比較 */
function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    res.status(503).json({ error: 'cron not configured' });
    return;
  }
  /* Vercel Cron は Authorization: Bearer で CRON_SECRET を送る。URLクエリは記録に残るため受け付けない（Issue #4） */
  const auth = String((req.headers && (req.headers.authorization || req.headers['Authorization'])) || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!timingSafeEq(bearer, secret)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const store = await getStore();
    const released = await store.expireStale();
    const thankYous = await sendThankYouEmails(store);
    let emailsRetried = 0;
    /* メール失敗（3回未満）の confirmed 予約を再送 */
    if (emailConfigured(emailConfig())) {
      const list = await store.listBookings({});
      for (const b of list) {
        if (b.status === 'confirmed' && b.email_status === 'failed') {
          const fails = await store.emailFailCount(b.id);
          if (fails >= 3) continue;
          const results = await sendBookingEmailsSafe(b);
          const okAll = results.customer.ok && results.owner.ok;
          const status = okAll ? 'sent' : 'failed';
          await store.updateBooking(b.id, { email_status: status });
          await store.logEmail({ booking_id: b.id, kind: 'retry', status, detail: String(results.customer.errorText || '') });
          emailsRetried++;
        }
      }
    }
    res.status(200).json({ released, thankYous, emailsRetried });
  } catch (err) {
    console.error('cron error:', err);
    res.status(500).json({ error: 'internal error' });
  }
}

async function sendBookingEmailsSafe(b) {
  try {
    return await confirmResend(b);
  } catch (e) {
    return { customer: { ok: false, errorText: String(e) }, owner: { ok: false, errorText: '' } };
  }
}

import { sendBookingEmails as confirmResend } from '../lib/email.js';
import { sendThankYou } from '../lib/email.js';

/* チェックアウト翌日（日本時間）の確定予約にお礼メールを送る（一度だけ） */
export async function sendThankYouEmails(store) {
  if (!emailConfigured(emailConfig())) return 0;
  const today = tokyoToday();
  const list = await store.listBookings({});
  let sent = 0;
  for (const b of list) {
    if (b.status !== 'confirmed' || b.thankyou_sent === 'sent' || b.thankyou_sent === 'skipped') continue;
    const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b.checkout || '');
    if (!p) continue;
    const outDay = new Date(Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3])));
    const yesterday = new Date(Date.UTC(new Date(today + 'T00:00:00Z').getUTCFullYear(), new Date(today + 'T00:00:00Z').getUTCMonth(), new Date(today + 'T00:00:00Z').getUTCDate() - 1));
    if (outDay.getTime() !== yesterday.getTime()) continue;
    const r = await sendThankYou(b);
    const okFlag = r.ok ? 'sent' : 'failed';
    await store.updateBooking(b.id, { thankyou_sent: okFlag });
    await store.logEmail({ booking_id: b.id, kind: 'thankyou', status: okFlag, detail: String(r.errorText || '') });
    if (r.ok) sent++;
  }
  return sent;
}
