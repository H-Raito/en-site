// 定期メンテナンス: 期限切れ仮予約の解放と、失敗した予約メールの再送。
// Vercel Cron（1日1回）+ 予約作成・照会時の遅延実行で二重に動く。CRON_SECRETで保護。
import { getStore } from '../lib/store.js';
import { confirmAndNotify } from '../lib/confirm.js';
import { emailConfigured, emailConfig } from '../lib/email.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    res.status(503).json({ error: 'cron not configured' });
    return;
  }
  const q = new URLSearchParams((req.url.split('?')[1]) || '');
  const provided = (req.headers && req.headers['x-cron-secret']) || q.get('key') || '';
  if (provided !== secret) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const store = await getStore();
    const released = await store.expireStale();
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
    res.status(200).json({ released, emailsRetried });
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
