export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  /** JSON-ключ сервісного акаунта Google (секрет). */
  GOOGLE_SA_KEY: string;
  /** Telegram ID власника. */
  OWNER_ID: string;
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

export const sheetUrl = (sheetId: string) => `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
