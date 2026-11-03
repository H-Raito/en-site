// 予約確定＋メール送信の共通経路（verify と webhook の両方から呼ばれる）。
// 冪等: confirmBooking の排他的遷移により、二重呼び出しでもメールは一度だけ送る。
import { sendBookingEmails } from './email.js';

export async function confirmAndNotify(store, id, paymentIntentId) {
  const { booking, changed } = await store.confirmBooking(id, paymentIntentId);
  if (!changed) {
    return { booking, emailsSent: false };
  }
  const results = await sendBookingEmails(booking);
  const customerOk = results.customer && results.customer.ok;
  const ownerOk = results.owner && results.owner.ok;
  const emailStatus = customerOk && ownerOk ? 'sent'
    : (results.customer.skipped || results.owner.skipped) ? 'skipped' : 'failed';
  try {
    await store.updateBooking(id, { email_status: emailStatus });
    await store.logEmail({ booking_id: id, kind: 'customer', status: customerOk ? 'sent' : (results.customer.skipped ? 'skipped' : 'failed'), detail: String(results.customer.errorText || '') });
    await store.logEmail({ booking_id: id, kind: 'owner', status: ownerOk ? 'sent' : (results.owner.skipped ? 'skipped' : 'failed'), detail: String(results.owner.errorText || '') });
  } catch (e) {
    console.error('email log error:', e);
  }
  return { booking: { ...booking, email_status: emailStatus }, emailsSent: true };
}
