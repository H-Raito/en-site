// 予約システム共通ユーティリティ（日付はすべて 'YYYY-MM-DD' 文字列で扱う・日本時間基準）
import { randomBytes } from 'node:crypto';

export function tokyoToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

/* 厳密な 'YYYY-MM-DD' パース（実在日のみ）。不正なら null */
export function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function dateToUTC(dt) { return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()); }

export function fmtUTC(ms) {
  const dt = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return dt.getUTCFullYear() + '-' + p(dt.getUTCMonth() + 1) + '-' + p(dt.getUTCDate());
}

/* 宿泊夜の列挙。[checkin, checkout) の各日（チェックアウト日は含まない） */
export function eachNight(checkin, checkout) {
  const a = parseDate(checkin);
  const b = parseDate(checkout);
  const out = [];
  for (let t = dateToUTC(a); t < dateToUTC(b); t += 86400000) out.push(fmtUTC(t));
  return out;
}

export function nightsBetween(checkin, checkout) {
  return Math.round((dateToUTC(parseDate(checkout)) - dateToUTC(parseDate(checkin))) / 86400000);
}

/* 予約番号: EN-<base36時刻>-<乱数4> （一意性はストア側でも保証）。
   乱数部は crypto.randomBytes（Math.random は予測可能性が保証されない・Issue #14） */
export function newBookingId() {
  const t = Date.now().toString(36).toUpperCase();
  const r = randomBytes(3).toString('hex').toUpperCase();
  return 'EN-' + t + '-' + r;
}

/* JSON body読み取り（64KB上限） */
export function readJsonBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      raw += c;
      if (raw.length > 65536) { tooLarge = true; resolve(null); }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

export function capStr(v, n) {
  return typeof v === 'string' ? v.slice(0, n) : '';
}

export function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s == null ? '' : s).trim());
}

export function isValidPhone(s) {
  return /^\d{10,11}$/.test(String(s == null ? '' : s).replace(/[-\s]/g, ''));
}

export function isKana(s) {
  return /^[ぁ-んァ-ヶー・\s]+$/.test(String(s == null ? '' : s).trim());
}

/* マスク: 「タナカ」→「タ○」 */
export function maskName(s) {
  const str = String(s == null ? '' : s);
  if (!str) return '';
  return str[0] + '○'.repeat(Math.max(str.length - 1, 1));
}
