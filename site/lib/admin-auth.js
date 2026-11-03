// 管理者認証。
// - 管理者ごとのアカウント（ユーザー名+パスワード・scryptハッシュでDB管理・ADMIN_SEED環境変数から初期投入）
// - ログイン成功で HMAC 署名付き HttpOnly クッキー（8時間）を発行
// - ログイン試行制限（ユーザー名あたり5回/15分）
// - CSRF対策: 変更系POSTは x-requested-with ヘッダ必須（カスタムヘッダはCSRF時に送れない）
import { createHmac, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function key() {
  return process.env.ADMIN_KEY || '';
}

export function adminEnabled() {
  return key().length >= 8;
}

/* 管理者アカウントの初期投入設定（ADMIN_SEED = "表示名:ユーザー名:パスワード,..."） */
export function adminSeedEntries() {
  const seed = process.env.ADMIN_SEED || '';
  const out = [];
  for (const part of seed.split(',')) {
    const seg = part.split(':');
    if (seg.length >= 3 && seg[0].trim() && seg[1].trim() && seg[2].trim()) {
      out.push({ name: seg[0].trim(), username: seg[1].trim(), password: seg.slice(2).join(':') });
    }
  }
  return out;
}

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + scryptSync(String(password), salt, 64).toString('hex');
}

export function verifyPassword(password, stored) {
  const i = String(stored || '').indexOf(':');
  if (i <= 0) return false;
  const salt = stored.slice(0, i);
  const hash = stored.slice(i + 1);
  const computed = scryptSync(String(password), salt, 64).toString('hex');
  const ab = Buffer.from(computed);
  const bb = Buffer.from(hash);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/* ---- ログイン試行制限（プロセス内・ユーザー名単位） ---- */
const attempts = new Map();

export function loginBlocked(username) {
  const rec = attempts.get(username);
  if (!rec) return false;
  if (Date.now() - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(username);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

export function recordLoginFailure(username) {
  const rec = attempts.get(username);
  if (!rec || Date.now() - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.set(username, { first: Date.now(), count: 1 });
    return;
  }
  rec.count++;
}

export function clearLoginFailures(username) {
  attempts.delete(username);
}

/* ---- セッショントークン ---- */
function hmac(data) {
  return createHmac('sha256', key()).update(String(data)).digest('hex');
}

export function issueToken(username) {
  const ts = String(Date.now());
  return ts + '.' + username + '.' + hmac(ts + '.' + username);
}

export function verifyToken(token) {
  if (!adminEnabled() || typeof token !== 'string') return null;
  const seg = token.split('.');
  if (seg.length !== 3) return null;
  const ts = seg[0];
  const username = seg[1];
  const n = Number(ts);
  if (!Number.isFinite(n) || Date.now() - n > TOKEN_TTL_MS) return null;
  const ab = Buffer.from(hmac(ts + '.' + username));
  const bb = Buffer.from(seg[2]);
  if (ab.length !== bb.length || !timingSafeEqual(ab, bb)) return null;
  return username;
}

export function isAdmin(req) {
  const cookies = (req.headers && req.headers.cookie) || '';
  const m = /(?:^|;\s*)en_admin=([A-Za-z0-9.]+)/.exec(cookies);
  if (m) {
    const username = verifyToken(m[1]);
    if (username) return username;
  }
  /* レガシー: x-admin-key ヘッダ（移行期の運用用。設定されていれば許可） */
  const header = req.headers && req.headers['x-admin-key'];
  if (header && checkAdminKey(header)) return 'legacy-key';
  return null;
}

export function checkAdminKey(candidate) {
  if (!adminEnabled()) return false;
  const ab = Buffer.from(String(candidate || ''));
  const bb = Buffer.from(key());
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/* CSRF: 変更系POSTはカスタムヘッダ必須（クロスオリジンからは送れない） */
export function csrfOk(req) {
  const h = req.headers && (req.headers['x-requested-with'] || req.headers['X-Requested-With']);
  return h === 'XMLHttpRequest';
}
