// «Що надіслати зараз»: нагадування за 30 хв до початку і щоденне зведення в годину відкриття.
// Чиста функція без мережі: на вхід — броні, розклад, поточний момент і вже надіслані ключі.
//
// Наздоганяння після простою: нагадування шлемо, доки бронь не закінчилась (якщо вже почалась —
// «Уже почалось»); зведення — доки робочий день не закінчився (з позначкою «із запізненням»).

import { esc, pcsLabel } from "./card";
import { windowOf, type DaySchedule } from "./hours";
import { MIN_PER_DAY, formatHHMM } from "./time";
import type { Entry } from "./views";

/** За скільки хвилин до початку нагадувати. */
export const REMIND_BEFORE = 30;
/** Зведення, надіслане пізніше за стільки хвилин після відкриття, позначається «із запізненням». */
const SUMMARY_LATE_AFTER = 10;

export type Action =
  | { kind: "reminder"; key: string; entry: Entry; minutesLeft: number; started: boolean }
  | { kind: "summary"; key: string; day: number; at: number; late: boolean };

export interface PlanInput {
  entries: Entry[];
  schedule: DaySchedule[];
  /** «Цілодобові дні: розклад з» (C15), хвилини — коли слати зведення в цілодобовий день. */
  firstHour: number;
  /** Поточна абсолютна хвилина клубу. */
  now: number;
  /** Ключі вже надісланого. */
  sent: Set<string>;
}

/** Ключ нагадування: бронь бота — за ID і часом початку; ручна — за датою/часом/ПК/ім'ям. */
export function reminderKey(e: Entry): string {
  return e.id ? `r:${e.id}:${e.start}` : `r:m:${e.start}:${e.pcs[0]}-${e.pcs.at(-1)}:${e.name}`;
}

export const summaryKey = (day: number) => `s:${day}`;

/** Коли в цей день слати зведення (абс. хвилини) і коли закінчується робочий день; null — вихідний. */
export function summaryTime(schedule: DaySchedule[], firstHour: number, day: number): { at: number; until: number } | null {
  const w = windowOf(schedule, day);
  if (w.end <= w.start) return null;
  const allDay = w.start === day * MIN_PER_DAY && w.end === (day + 1) * MIN_PER_DAY;
  return { at: allDay ? day * MIN_PER_DAY + firstHour : w.start, until: w.end };
}

export function planNotifications(input: PlanInput): Action[] {
  const { entries, schedule, firstHour, now, sent } = input;
  const actions: Action[] = [];

  // Зведення: сьогоднішній день і вчорашній (якщо його нічне вікно ще триває).
  const today = Math.floor(now / MIN_PER_DAY);
  for (const day of [today - 1, today]) {
    const t = summaryTime(schedule, firstHour, day);
    if (!t || now < t.at || now >= t.until) continue;
    const key = summaryKey(day);
    if (sent.has(key)) continue;
    actions.push({ kind: "summary", key, day, at: t.at, late: now - t.at > SUMMARY_LATE_AFTER });
  }

  // Нагадування: настав момент «за 30 хв», а бронь ще не закінчилась.
  for (const e of entries) {
    if (e.start - REMIND_BEFORE > now || e.end <= now) continue;
    const key = reminderKey(e);
    if (sent.has(key)) continue;
    actions.push({ kind: "reminder", key, entry: e, minutesLeft: Math.max(0, e.start - now), started: e.start <= now });
  }
  return actions;
}

/** Текст нагадування: «⏰ Через 30 хв (19:00–02:00): ПК 12–17 (6 ПК) — Vova (tg)». */
export function reminderText(a: Extract<Action, { kind: "reminder" }>, pcList: number[]): string {
  const e = a.entry;
  const when = `${formatHHMM(e.start)}–${formatHHMM(e.end)}`;
  const who = `${esc(e.name || "без імені")}${e.contact ? ` (${esc(e.contact)})` : ""}`;
  const head = a.started ? `⏰ Уже почалось (${when})` : `⏰ Через ${a.minutesLeft} хв (${when})`;
  return `${head}: ${pcsLabel(e.pcs, pcList)} — ${who}${e.note ? `\n📝 ${esc(e.note)}` : ""}`;
}

/* ───────────── відмітка «прийшов / не прийшов» у примітці ───────────── */

const MARK_RX = /\s*(?:·\s*)?(?:✅ прийшов|❌ не прийшов) \([^)]*\)/gu;

/** Примітка з новою відміткою (попередня відмітка замінюється, решта тексту зберігається). */
export function withAttendance(note: string, came: boolean, by: string, at: string): string {
  const clean = note.replace(MARK_RX, "").trim();
  const mark = `${came ? "✅ прийшов" : "❌ не прийшов"} (${by} ${at})`;
  return clean ? `${clean} · ${mark}` : mark;
}
