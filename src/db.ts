// Дрібні сховища в D1: кеш із терміном дії і замок для запису в таблицю.

export async function cacheGet(db: D1Database, key: string, now = Date.now()): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM cache WHERE key = ?1 AND expires_at > ?2")
    .bind(key, now)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function cachePut(db: D1Database, key: string, value: string, ttlMs: number, now = Date.now()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    )
    .bind(key, value, now + ttlMs)
    .run();
}

export async function cacheDelete(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM cache WHERE key = ?1").bind(key).run();
}

/** Спроба взяти замок. Прострочений замок (упав воркер) перехоплюється. */
export async function tryLock(db: D1Database, name: string, holder: string, ttlMs: number, now = Date.now()): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO locks (name, holder, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
       WHERE locks.expires_at < ?4`,
    )
    .bind(name, holder, now + ttlMs, now)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export async function unlock(db: D1Database, name: string, holder: string): Promise<void> {
  await db.prepare("DELETE FROM locks WHERE name = ?1 AND holder = ?2").bind(name, holder).run();
}

export class LockBusyError extends Error {
  constructor() {
    super("Таблицю зараз записує інший адміністратор — спробуйте ще раз за кілька секунд");
  }
}

/**
 * Виконати `fn` під замком. Чекаємо до ~`waitMs`, перевіряючи кожні `stepMs`.
 * Очікування — це час I/O, а не CPU, тож у ліміт 10 мс не входить.
 */
export async function withLock<T>(
  db: D1Database,
  name: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; waitMs?: number; stepMs?: number } = {},
): Promise<T> {
  const { ttlMs = 25_000, waitMs = 8_000, stepMs = 250 } = opts;
  const holder = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  while (!(await tryLock(db, name, holder, ttlMs))) {
    if (Date.now() >= deadline) throw new LockBusyError();
    await new Promise((r) => setTimeout(r, stepMs));
  }
  try {
    return await fn();
  } finally {
    await unlock(db, name, holder);
  }
}
