// Дати й час у тому вигляді, в якому їх зберігає Google Таблиця.
//
// Таблиця рахує «настінний» час клубу: дата — серійне число (днів від 30.12.1899),
// час — частка доби. Початок броні = A + D, кінець = A + E (+1 доба, якщо E ≤ D).
// Бот рахує так само, тільки в цілих хвилинах: «абсолютна хвилина» = серійна дата × 1440 + хвилини.
// Переходи на літній/зимовий час таблиця не враховує — і бот теж (для настінного часу це правильно).

export const MIN_PER_DAY = 1440;
const MS_PER_DAY = 86_400_000;
/** 30.12.1899 — нуль серійних дат Google Таблиць. */
const SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);

export interface YMD {
  y: number;
  m: number; // 1–12
  d: number;
}

/** Календарна дата → серійне число таблиці (ціле). */
export function dateToSerial(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - SERIAL_EPOCH_MS) / MS_PER_DAY);
}

/** Серійне число (можна з дробовою частиною) → календарна дата. */
export function serialToDate(serial: number): YMD {
  const date = new Date(SERIAL_EPOCH_MS + Math.floor(serial) * MS_PER_DAY);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

/** Чи існує така дата (31.02 — ні). */
export function isValidDate(y: number, m: number, d: number): boolean {
  const s = serialToDate(dateToSerial(y, m, d));
  return s.y === y && s.m === m && s.d === d;
}

/** Хвилини від початку доби → частка доби для запису в таблицю. */
export const minutesToFraction = (minutes: number): number => minutes / MIN_PER_DAY;

/**
 * Частка доби з таблиці → цілі хвилини. Таблиця повертає 0.666666666666667 замість 2/3,
 * тому округлюємо. Дробову частину беремо як MOD(x; 1) — так само роблять формули таблиці.
 */
export function fractionToMinutes(fraction: number): number {
  const minutes = Math.round((fraction - Math.floor(fraction)) * MIN_PER_DAY);
  return minutes === MIN_PER_DAY ? 0 : minutes;
}

/** «19:00», «9:30», «19.00» → хвилини. «24:00» → 1440. Некоректне → null. */
export function parseHHMM(text: string): number | null {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/** Хвилини (можна > 1440) → «HH:MM» у межах доби. */
export function formatHHMM(minutes: number): string {
  const t = ((minutes % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** Серійна дата → «21.11.2026». */
export function formatDate(serial: number): string {
  const { y, m, d } = serialToDate(serial);
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;
}

/** День тижня серійної дати: 0 = Пн … 6 = Нд (як WEEKDAY(x; 2) − 1). */
export function weekdayIndex(serial: number): number {
  // 30.12.1899 — субота (індекс 5).
  return (((Math.floor(serial) + 5) % 7) + 7) % 7;
}

/** Понеділок тижня, у якому лежить дата (як B3 − WEEKDAY(B3; 3)). */
export const mondayOf = (serial: number): number => Math.floor(serial) - weekdayIndex(serial);

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Поточні дата й час у часовому поясі клубу: серійна дата і хвилини від початку доби. */
export function zonedNow(timeZone: string, now: Date = new Date()): { serial: number; minutes: number } {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, fmt);
  }
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(now)) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return {
    serial: dateToSerial(parts.year!, parts.month!, parts.day!),
    minutes: parts.hour! * 60 + parts.minute!,
  };
}

/** Поточна «абсолютна хвилина» клубу (серійна дата × 1440 + хвилини). */
export function nowAbs(timeZone: string, now: Date = new Date()): number {
  const z = zonedNow(timeZone, now);
  return z.serial * MIN_PER_DAY + z.minutes;
}
