export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  /** JSON-ключ сервісного акаунта Google (секрет). */
  GOOGLE_SA_KEY: string;
  /** Telegram ID власника. */
  OWNER_ID: string;
  /** Додаткові Telegram ID адміністраторів (через кому або пробіл); OWNER_ID завжди є адміном. */
  ADMIN_IDS?: string;
  /** Опціональний резервний ID закритого адмін-чату (якщо гілка ще не прив'язана в D1). */
  ADMIN_CHAT_ID?: string;
  ADMIN_THREAD_ID?: string;
  TZ: string;
  SHEET_ID: string;
  BOT_INFO: string;
}

export interface Config {
  ownerId: number;
  timeZone: string;
  sheetId: string;
}

export function getConfig(env: Env): Config {
  const ownerId = Number(String(env.OWNER_ID ?? "").trim());
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new Error("OWNER_ID не задано: вкажіть Telegram ID власника в wrangler.toml");
  }
  if (!env.SHEET_ID) throw new Error("SHEET_ID не задано у wrangler.toml");
  return { ownerId, timeZone: env.TZ || "Europe/Warsaw", sheetId: env.SHEET_ID };
}

/** Множина Telegram ID усіх авторизованих адміністраторів (OWNER_ID + ADMIN_IDS). */
export function parseAdminIds(env: Env): Set<number> {
  const ids = new Set<number>();
  const owner = Number(String(env.OWNER_ID ?? "").trim());
  if (Number.isSafeInteger(owner) && owner > 0) ids.add(owner);
  for (const part of String(env.ADMIN_IDS ?? "").split(/[\s,;]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const id = Number(trimmed);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

/** Єдина перевірка прав адміністратора для адмін-команд і повних карток бронювань. */
export function isAdmin(userId: number | undefined | null, env: Env): boolean {
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) return false;
  return parseAdminIds(env).has(userId);
}

/** Username бота з кешованого `BOT_INFO` або запасного значення. */
export function getBotUsername(env: Env, fallback?: string): string | null {
  if (env.BOT_INFO) {
    try {
      const info = JSON.parse(env.BOT_INFO) as { username?: unknown };
      if (typeof info.username === "string" && info.username.trim()) return info.username.trim();
    } catch {
      // ігноруємо пошкоджений BOT_INFO
    }
  }
  return fallback?.trim() || null;
}

export const sheetUrl = (sheetId: string) => `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
