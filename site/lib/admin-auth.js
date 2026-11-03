// 管理者認証。ADMIN_KEY 環境変数を鍵にHMAC署名付きクッキーを発行する。
// ADMIN_KEY 未設定なら管理機能全体が無効（503）になる。
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function key() {
  return process.env.ADMIN_KEY || '';
}

export function adminEnabled() {
  return key().length >= 8;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function checkAdminKey(candidate) {
  if (!adminEnabled()) return false;
  return safeEqual(candidate || '', key());
}

function hmac(data) {
  return createHmac('sha256', key()).update(String(data)).digest('hex');
}

export function issueToken() {
  const ts = String(Date.now());
  return ts + '.' + hmac(ts);
}

export function verifyToken(token) {
  if (!adminEnabled() || typeof token !== 'string') return false;
  const i = token.indexOf('.');
  if (i <= 0) return false;
  const ts = token.slice(0, i);
  const sig = token.slice(i + 1);
  const n = Number(ts);
  if (!Number.isFinite(n) || Date.now() - n > TOKEN_TTL_MS) return false;
  return safeEqual(sig, hmac(ts));
}

export function isAdmin(req) {
  const header = req.headers && req.headers['x-admin-key'];
  if (header && checkAdminKey(header)) return true;
  const cookies = (req.headers && req.headers.cookie) || '';
  const m = /(?:^|;\s*)en_admin=([A-Za-z0-9.]+)/.exec(cookies);
  if (m && verifyToken(m[1])) return true;
  return false;
}
