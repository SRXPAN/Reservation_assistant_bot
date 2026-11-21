// Запасний розбір через Workers AI — лише коли ознаки броні є, а детермінований розбір щось пропустив.
// Відповідь моделі — строго JSON за схемою; кожне поле перевіряємо, сумнівне відкидаємо.

import { cacheGet, cachePut } from "./db";
import type { Draft } from "./parse";
import { WEEKDAY_SHORT } from "./parse";
import { dateToSerial, formatDate, isValidDate, parseHHMM, weekdayIndex } from "./time";

export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** Скільки звернень до ШІ на добу (безкоштовні 10 000 нейронів — це сотні таких запитів, беремо з запасом). */
export const AI_DAILY_LIMIT = 60;
const AI_TIMEOUT_MS = 8_000;

export interface AiBinding {
  run(model: string, inputs: unknown): Promise<unknown>;
}

const SCHEMA = {
  type: "object",
  properties: {
    date: { type: ["string", "null"], description: "YYYY-MM-DD" },
    pcs: { type: "array", items: { type: "integer" } },
    from: { type: ["string", "null"], description: "HH:MM" },
    to: { type: ["string", "null"], description: "HH:MM" },
    name: { type: ["string", "null"] },
    contact: { type: ["string", "null"] },
    note: { type: ["string", "null"] },
  },
  required: ["date", "pcs", "from", "to", "name", "contact", "note"],
} as const;

function prompt(today: number): string {
  return [
    "Ти розбираєш повідомлення адміністратора комп'ютерного клубу про бронювання ПК.",
    `Сьогодні ${formatDate(today)} (${WEEKDAY_SHORT[weekdayIndex(today)]}). День тижня без дати — найближчий такий день від сьогодні.`,
    "Поверни ЛИШЕ JSON з полями:",
    "date — дата броні YYYY-MM-DD або null;",
    "pcs — номери ПК (діапазон 12-17 розгорни в усі номери; «5 пк» — це ПК номер 5);",
    "from, to — час HH:MM (24-годинний; «з 19 до 2» → 19:00 і 02:00; «на 3 години» — додай до початку) або null;",
    "name — ім'я клієнта або null; contact — телефон, «tg», «insta» тощо або null; note — решта корисного тексту або null.",
    "Нічого не вигадуй: чого немає в тексті — null.",
  ].join("\n");
}

/** Перевірити відповідь моделі і перетворити в часткову чернетку. Повертає null, якщо відповідь непридатна. */
export function validateAiAnswer(raw: unknown, today: number, pcList: number[]): Partial<Draft> | null {
  let obj = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const out: Partial<Draft> = {};

  if (typeof o.date === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(o.date);
    if (m && isValidDate(+m[1]!, +m[2]!, +m[3]!)) {
      const serial = dateToSerial(+m[1]!, +m[2]!, +m[3]!);
      if (serial >= today - 7 && serial <= today + 366) out.date = serial;
    }
  }
  if (Array.isArray(o.pcs)) {
    const pcs = o.pcs.filter((n): n is number => Number.isInteger(n) && pcList.includes(n as number));
    if (pcs.length && pcs.length === o.pcs.length) out.pcs = [...new Set(pcs)].sort((a, b) => a - b);
  }
  for (const key of ["from", "to"] as const) {
    if (typeof o[key] === "string") {
      const v = parseHHMM(o[key] as string);
      if (v !== null) out[key] = v;
    }
  }
  for (const key of ["name", "contact", "note"] as const) {
    const v = o[key];
    if (typeof v === "string" && v.trim() && v.length <= 120) out[key] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

/** Денний ліміт викликів (лічильник у D1). */
async function takeQuota(db: D1Database, today: number): Promise<boolean> {
  const key = `ai_calls:${today}`;
  const used = Number((await cacheGet(db, key)) ?? 0);
  if (used >= AI_DAILY_LIMIT) return false;
  await cachePut(db, key, String(used + 1), 2 * 86_400_000);
  return true;
}

export async function aiParse(
  ai: AiBinding | undefined,
  db: D1Database,
  text: string,
  today: number,
  pcList: number[],
): Promise<Partial<Draft> | null> {
  if (!ai || !(await takeQuota(db, today))) return null;
  try {
    const run = ai.run(AI_MODEL, {
      messages: [
        { role: "system", content: prompt(today) },
        { role: "user", content: text.slice(0, 500) },
      ],
      response_format: { type: "json_schema", json_schema: SCHEMA },
      max_tokens: 200,
      temperature: 0,
    });
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), AI_TIMEOUT_MS));
    const res = (await Promise.race([run, timeout])) as { response?: unknown } | null;
    return res ? validateAiAnswer(res.response, today, pcList) : null;
  } catch (err) {
    console.error("Workers AI: помилка", err);
    return null;
  }
}

/** Доповнити детерміновану чернетку відповіддю ШІ: заповнюються лише порожні поля. */
export function mergeAi(draft: Draft, ai: Partial<Draft>): { draft: Draft; used: boolean } {
  const out: Draft = { ...draft, hints: [...draft.hints] };
  let used = false;
  if (out.date === null && ai.date !== undefined) (out.date = ai.date), (used = true);
  if (!out.pcs.length && ai.pcs?.length) (out.pcs = ai.pcs), (used = true);
  if (out.from === null && ai.from !== undefined) (out.from = ai.from), (used = true);
  if (out.to === null && ai.to !== undefined) (out.to = ai.to), (used = true);
  if (!out.name && ai.name) (out.name = ai.name), (used = true);
  if (!out.contact && ai.contact) (out.contact = ai.contact), (used = true);
  if (used) out.hints.push("🤖 Частину розпізнав ШІ — перевірте уважно");
  return { draft: out, used };
}
