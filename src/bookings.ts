// Броні з аркуша «Бронювання»: розбір рядків, групи ПК, накладки і статус «як рахує таблиця».
// Модуль без мережі й Telegram — його перевіряють тести.

import { isWithinHours, type DaySchedule } from "./hours";
import { MIN_PER_DAY } from "./time";

/** Перший рядок даних і останній рядок, до якого протягнуті формули I–T. */
export const FIRST_ROW = 10;
export const LAST_ROW = 1009;

/** Рядок аркуша «Бронювання» в тому вигляді, як його бачить бот. */
export interface SheetBooking {
  /** Номер рядка в аркуші (1-based). */
  row: number;
  /** A — серійна дата. */
  date: number | null;
  /** B, C — як записано (C порожня для одного ПК). */
  pcB: number | null;
  pcC: number | null;
  /** D, E — хвилини від початку доби (E може дорівнювати 1440). */
  from: number | null;
  to: number | null;
  name: string;
  contact: string;
  note: string;
  /** K — статус, який порахувала таблиця. */
  status: string;
  /** U — ID бота (порожньо для ручних броней). */
  botId: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string => (v === undefined || v === null ? "" : String(v)).trim();
const isBlank = (v: unknown): boolean => v === undefined || v === null || v === "";
/** Час із таблиці без MOD: 1 (24:00) лишається 1440, як у формулі L/M. */
const timeMinutes = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n * MIN_PER_DAY);
};

/**
 * Рядки «Бронювання»!A10:U1009 (UNFORMATTED_VALUE, SERIAL_NUMBER) → броні.
 * Повністю порожні рядки (A, B, F порожні) пропускаються.
 */
export function parseBookingRows(values: unknown[][], firstRow = FIRST_ROW): SheetBooking[] {
  const out: SheetBooking[] = [];
  values.forEach((r, i) => {
    if (isBlank(r[0]) && isBlank(r[1]) && isBlank(r[5])) return;
    const date = num(r[0]);
    out.push({
      row: firstRow + i,
      date: date === null ? null : Math.floor(date),
      pcB: num(r[1]),
      pcC: num(r[2]),
      from: timeMinutes(r[3]),
      to: timeMinutes(r[4]),
      name: text(r[5]),
      contact: text(r[6]),
      note: text(r[7]),
      status: text(r[10]),
      botId: text(r[20]),
    });
  });
  return out;
}

/** Номери вільних рядків (A, B і F порожні) у порядку зростання. */
export function freeRows(values: { a: unknown; b: unknown; f: unknown }[], firstRow = FIRST_ROW, lastRow = LAST_ROW): number[] {
  const free: number[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    const v = values[row - firstRow];
    if (!v || (isBlank(v.a) && isBlank(v.b) && isBlank(v.f))) free.push(row);
  }
  return free;
}

/** Інтервал броні в абсолютних хвилинах. «До» ≤ «Від» — наступного дня. */
export function bookingInterval(date: number, from: number, to: number): { start: number; end: number } {
  const start = date * MIN_PER_DAY + from;
  const end = date * MIN_PER_DAY + to + (to <= from ? MIN_PER_DAY : 0);
  return { start, end };
}

/** Повна бронь: є дата, ПК і обидва часи (лише такі таблиця враховує в накладках). */
export interface CompleteBooking extends SheetBooking {
  date: number;
  pcB: number;
  from: number;
  to: number;
  /** O, P — менший і більший ПК групи. */
  lo: number;
  hi: number;
  start: number;
  end: number;
}

export function complete(b: SheetBooking): CompleteBooking | null {
  if (b.date === null || b.pcB === null || b.from === null || b.to === null) return null;
  const c = b.pcC ?? b.pcB;
  return {
    ...b,
    date: b.date,
    pcB: b.pcB,
    from: b.from,
    to: b.to,
    lo: Math.min(b.pcB, c),
    hi: Math.max(b.pcB, c),
    ...bookingInterval(b.date, b.from, b.to),
  };
}

/** ПК зі списку «Налаштування», що входять у діапазон [lo; hi] (як COUNTIFS у колонці I). */
export const pcsInRange = (pcList: number[], lo: number, hi: number): number[] =>
  pcList.filter((pc) => pc >= lo && pc <= hi).sort((a, b) => a - b);

/**
 * Вибрані ПК → рядки таблиці: кожен рядок — безперервний відрізок списку ПК.
 * «12, 14, 16» → три рядки; «12–17» → один рядок B=12, C=17.
 */
export function splitIntoRuns(pcs: number[], pcList: number[]): { first: number; last: number }[] {
  const chosen = new Set(pcs);
  const runs: { first: number; last: number }[] = [];
  let current: { first: number; last: number } | null = null;
  for (const pc of [...new Set(pcList)].sort((a, b) => a - b)) {
    if (chosen.has(pc)) {
      if (current) current.last = pc;
      else current = { first: pc, last: pc };
    } else if (current) {
      runs.push(current);
      current = null;
    }
  }
  if (current) runs.push(current);
  return runs;
}

/** Чи перетинаються два інтервали. Впритул (19–21 і 21–23) — не накладка. */
export const intervalsOverlap = (a: { start: number; end: number }, b: { start: number; end: number }): boolean =>
  a.start < b.end && b.start < a.end;

export interface Conflict {
  booking: CompleteBooking;
  /** Які з наших ПК зайняті цією бронню. */
  pcs: number[];
}

/**
 * Перевірка нової броні: з якими існуючими бронями вона перетинається за ПК і часом.
 * `ignoreBotId` — не рахувати рядки цієї ж броні (при зміні вже записаної).
 */
export function findConflicts(
  candidate: { pcs: number[]; start: number; end: number },
  existing: SheetBooking[],
  ignoreBotId?: string,
): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const raw of existing) {
    if (ignoreBotId && raw.botId === ignoreBotId) continue;
    const b = complete(raw);
    if (!b || !intervalsOverlap(candidate, b)) continue;
    const pcs = candidate.pcs.filter((pc) => pc >= b.lo && pc <= b.hi);
    if (pcs.length) conflicts.push({ booking: b, pcs });
  }
  return conflicts;
}

/**
 * Статус рядка так, як його порахує колонка K. Потрібен, щоб звіряти перевірку бота з таблицею.
 * `weekMon` — серійна дата понеділка вибраного в таблиці тижня (F3, WeekMon).
 */
export function expectedStatus(
  b: SheetBooking,
  all: SheetBooking[],
  schedule: DaySchedule[],
  pcList: number[],
  weekMon: number,
): string {
  const c = complete(b);
  if (!c) return "⚠ заповніть дату, ПК і час";
  const group = c.hi > c.lo;
  const overlap = all.some((other) => {
    if (other.row === b.row) return false;
    const o = complete(other);
    return !!o && o.lo <= c.hi && o.hi >= c.lo && intervalsOverlap(o, c);
  });
  if (overlap) return group ? "⚠ НАКЛАДКА: ПК з групи зайнятий" : "⚠ НАКЛАДКА: ПК вже зайнятий";
  if (!isWithinHours(schedule, c.date, c.start, c.end)) return "⏰ поза годинами роботи";
  const weekStart = weekMon * MIN_PER_DAY;
  if (c.start < weekStart || c.start >= weekStart + 7 * MIN_PER_DAY) return "✓ інший тиждень";
  return "✓ OK" + (group ? ` · група ${pcsInRange(pcList, c.lo, c.hi).length} ПК` : "");
}

/** «✓ OK», «✓ OK · група…», «✓ інший тиждень» — усе це означає «без проблем». */
export const isOkStatus = (status: string): boolean => status.startsWith("✓");

/** Нова бронь, підготовлена до запису. */
export interface NewBooking {
  date: number;
  pcs: number[];
  /** Хвилини від початку доби; `to` може бути 1440 (24:00). */
  from: number;
  to: number;
  name: string;
  contact: string;
  note: string;
}

/** Значення A–H одного рядка. Дата і час — числа, текст — як є (запис через RAW). */
export function rowValues(b: NewBooking, run: { first: number; last: number }): (string | number)[] {
  return [
    b.date,
    run.first,
    run.last === run.first ? "" : run.last,
    b.from / MIN_PER_DAY,
    b.to / MIN_PER_DAY,
    b.name,
    b.contact,
    b.note,
  ];
}

/** Короткий унікальний ID броні для колонки U, напр. «R-mhq3k2x1-7f3a0c». */
export function newBookingId(now: number = Date.now()): string {
  const rnd = crypto.getRandomValues(new Uint8Array(3));
  const hex = Array.from(rnd, (x) => x.toString(16).padStart(2, "0")).join("");
  return `R-${now.toString(36)}-${hex}`;
}
