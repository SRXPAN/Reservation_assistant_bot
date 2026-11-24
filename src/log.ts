// Гігієна логів: маскування телефонів/username і безпечне форматування помилок без payload/PII.

const PHONE_RX = /\+?\d[\d\s\-()]{7,18}\d/g;
const USER_RX = /@[a-zA-Z0-9_]{4,32}/g;

/** Замаскувати потенційні номери телефонів і Telegram @username у текстах помилок. */
export function redactPII(text: string): string {
  return text.replace(PHONE_RX, "[redacted-phone]").replace(USER_RX, "[redacted-user]");
}

/**
 * Безпечний опис помилки для `console.error` / `console.warn`.
 * Ніколи не серіалізує `payload`, `ctx`, `update` чи `request` (які можуть містити імена/телефони клієнтів).
 */
export function safeError(err: unknown): string {
  if (err === null || err === undefined) return "Unknown error";
  if (typeof err === "string") return redactPII(err);
  if (typeof err === "object") {
    const e = err as { name?: unknown; message?: unknown; description?: unknown; error_code?: unknown; status?: unknown; error?: unknown };
    // BotError із grammY містить поле `error` із внутрішньою помилкою та `ctx` з update.
    if (e.error !== undefined && ("ctx" in e || e.name === "BotError")) {
      return `BotError: ${safeError(e.error)}`;
    }
    const name = typeof e.name === "string" ? e.name : "Error";
    const code =
      typeof e.error_code === "number"
        ? ` (${e.error_code})`
        : typeof e.status === "number"
          ? ` (${e.status})`
          : "";
    const rawMsg =
      typeof e.description === "string" && e.description
        ? e.description
        : typeof e.message === "string" && e.message
          ? e.message
          : name;
    return `${name}${code}: ${redactPII(rawMsg)}`;
  }
  return redactPII(String(err));
}
