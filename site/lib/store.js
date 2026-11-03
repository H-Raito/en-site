// 予約データストア。
// DATABASE_URL があれば Postgres(Neon serverless driver) を使用。
// なければ開発・テスト用のメモリストア（Vercel上では無効・503になる）。
import { newBookingId } from './util.js';

let cachedStore = null;

export async function getStore() {
  if (globalThis.__enTestStore) return globalThis.__enTestStore;
  if (cachedStore) return cachedStore;
  if (process.env.DATABASE_URL) {
    const { createPgStore } = await import('./store-pg.js');
    cachedStore = createPgStore(process.env.DATABASE_URL);
    return cachedStore;
  }
  if (process.env.VERCEL) {
    const err = new Error('DATABASE_URL is not configured');
    err.code = 'not_configured';
    throw err;
  }
  const { createMemoryStore } = await import('./store-memory.js');
  cachedStore = createMemoryStore();
  return cachedStore;
}

/* テスト用リセット */
export function resetStoreCache() {
  cachedStore = null;
}
