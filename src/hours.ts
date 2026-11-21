// Години роботи з аркуша «Налаштування» (рядки 5–11, Пн–Нд) і перевірка «бронь у робочих годинах».
//
// Повторює формули таблиці:
//   Sched_S (X5:X11) = Години ? MOD(C) : 0
//   Sched_E (Y5:Y11) = Цілодобово ? 1 : Години ? MOD(D) + (MOD(D) ≤ MOD(C) ? 1 : 0) : 0
//   (порожні C або D у режимі «Години» → 0 і 0, тобто день зачинений)
// і ланцюжок у колонках R–T «Бронювання»: від початку броні йдемо через вікна
// дня A−1, A, A+1; бронь у годинах, якщо ланцюжок доходить до її кінця.

import { MIN_PER_DAY, fractionToMinutes, parseHHMM, weekdayIndex } from "./time";

export type DayMode = "Години" | "Цілодобово" | "Вихідний";

export interface DaySchedule {
  /** Режим як записано в таблиці; невідомий текст таблиця рахує як зачинений день. */
  mode: string;
  /** Початок вікна, хвилини від початку дня. */
  start: number;
  /** Кінець вікна, хвилини від початку дня (може бути > 1440 — закриття наступного дня). */
  end: number;
}

/** Значення клітинки часу (число-частка доби або текст «12:00») → хвилини. */
function cellMinutes(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return fractionToMinutes(value);
  if (typeof value === "string" && value.trim() !== "") {
    const m = parseHHMM(value);
    return m === null ? null : m % MIN_PER_DAY;
  }
  return null;
}

/** Рядки «Налаштування»!A5:D11 (без форматування) → розклад на 7 днів, Пн = 0. */
export function parseSchedule(rows: unknown[][]): DaySchedule[] {
  const days: DaySchedule[] = [];
  for (let i = 0; i < 7; i++) {
    const row = rows[i] ?? [];
    const mode = String(row[1] ?? "").trim();
    if (mode === "Цілодобово") {
      days.push({ mode, start: 0, end: MIN_PER_DAY });
      continue;
    }
    const open = cellMinutes(row[2]);
    const close = cellMinutes(row[3]);
    if (mode === "Години" && open !== null && close !== null) {
      days.push({ mode, start: open, end: close + (close <= open ? MIN_PER_DAY : 0) });
    } else {
      days.push({ mode, start: 0, end: 0 });
    }
  }
  return days;
}

/** Робоче вікно дня в абсолютних хвилинах. Порожнє вікно (start = end) — зачинено. */
export function windowOf(schedule: DaySchedule[], daySerial: number): { start: number; end: number } {
  const day = schedule[weekdayIndex(daySerial)]!;
  const base = daySerial * MIN_PER_DAY;
  return { start: base + day.start, end: base + day.end };
}

/**
 * До якої хвилини бронь, що починається в `startAbs` (дата броні — `dateSerial`), безперервно
 * покрита робочими вікнами. Точно як колонки R, S, T таблиці.
 */
export function coveredUntil(schedule: DaySchedule[], dateSerial: number, startAbs: number): number {
  let reach = startAbs;
  for (const k of [-1, 0, 1]) {
    const w = windowOf(schedule, dateSerial + k);
    if (w.start <= reach && w.end > reach) reach = w.end;
  }
  return reach;
}

/** Бронь повністю в робочих годинах (як відсутність «⏰» у статусі таблиці). */
export function isWithinHours(schedule: DaySchedule[], dateSerial: number, startAbs: number, endAbs: number): boolean {
  return coveredUntil(schedule, dateSerial, startAbs) >= endAbs;
}

/** Вікно, яке відкрите в момент `abs` (або null). Вікно попереднього дня має пріоритет — так рахує таблиця. */
export function openWindowAt(schedule: DaySchedule[], abs: number): { start: number; end: number; day: number } | null {
  const today = Math.floor(abs / MIN_PER_DAY);
  for (const day of [today - 1, today]) {
    const w = windowOf(schedule, day);
    if (w.start <= abs && w.end > abs) return { ...w, day };
  }
  return null;
}
