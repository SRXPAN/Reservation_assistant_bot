// Броні з аркуша «Бронювання»: розбір рядків, групи ПК, накладки і статус «як рахує таблиця».
// Модуль без мережі й Telegram — його перевіряють тести.

import { coveredUntil, isWithinHours, openWindowAt, windowOf, type DaySchedule } from "./hours";
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

/* ───────────── клієнтський підбір слотів і суміжних ПК ───────────── */

/** Публічний DTO доступності слотів/ПК — фізично без жодних персональних даних (PII). */
export interface PublicSlotSummary {
  date: number;
  start: number;
  end: number;
  zone: string;
  pcs: number[];
  status: "free" | "busy";
  freeCount?: number;
}

/** Повний адмінський DTO бронювання з персональними даними (лише для адмін-чату та адмінів). */
export interface AdminBookingDetails {
  id: string;
  rows: number[];
  date: number;
  start: number;
  end: number;
  pcs: number[];
  name: string;
  contact: string;
  note: string;
  statuses: string[];
  clientTgId?: number | null;
}

/** Перетворити сирі рядки таблиці у публічні інтервали зайнятості без жодних PII. */
export function toPublicBusySlots(
  bookings: readonly SheetBooking[],
  pcList: number[],
  zones: Record<number, string>,
): PublicSlotSummary[] {
  const out: PublicSlotSummary[] = [];
  for (const raw of bookings) {
    const b = complete(raw);
    if (!b) continue;
    const pcs = pcsInRange(pcList, b.lo, b.hi);
    const list = pcs.length ? pcs : [b.lo];
    const byZone = new Map<string, number[]>();
    for (const pc of list) {
      const z = (zones[pc] ?? "").trim() || "Загальна";
      const arr = byZone.get(z);
      if (arr) arr.push(pc);
      else byZone.set(z, [pc]);
    }
    for (const [zone, zonePcs] of byZone.entries()) {
      out.push({ date: b.date, start: b.start, end: b.end, zone, pcs: zonePcs, status: "busy" });
    }
  }
  return out;
}

/** Унікальні непорожні назви зон у порядку появи в `pcList`. */
export function availableZones(pcList: number[], zones: Record<number, string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const pc of pcList) {
    const z = (zones[pc] ?? "").trim();
    if (z && !seen.has(z)) {
      seen.add(z);
      out.push(z);
    }
  }
  return out;
}

/** Відсортовані унікальні номери ПК конкретної зони. */
export function zonePCs(pcList: number[], zones: Record<number, string>, zone: string): number[] {
  return [...new Set(pcList.filter((pc) => (zones[pc] ?? "").trim() === zone))].sort((a, b) => a - b);
}

/** Перетворити абсолютний інтервал [startAbs, endAbs) у (date, from, to) для таблиці. */
export function intervalToBookingTime(startAbs: number, endAbs: number): { date: number; from: number; to: number } {
  const date = Math.floor(startAbs / MIN_PER_DAY);
  const from = startAbs - date * MIN_PER_DAY;
  const to = endAbs % MIN_PER_DAY;
  return { date, from, to };
}

interface BusyInterval {
  start: number;
  end: number;
  lo?: number;
  hi?: number;
  pcs?: number[];
}

function isPublicSlot(b: SheetBooking | CompleteBooking | PublicSlotSummary | BusyInterval): b is PublicSlotSummary {
  return "status" in b && Array.isArray((b as PublicSlotSummary).pcs);
}

function toBusyList(bookings: readonly (SheetBooking | CompleteBooking | PublicSlotSummary | BusyInterval)[]): BusyInterval[] {
  const out: BusyInterval[] = [];
  for (const b of bookings) {
    if (isPublicSlot(b)) {
      if (b.status === "busy") out.push({ start: b.start, end: b.end, pcs: b.pcs });
    } else if ("lo" in b && "hi" in b && "start" in b && "end" in b) {
      out.push({ start: b.start, end: b.end, lo: b.lo, hi: b.hi });
    } else if ("start" in b && "end" in b && ("pcs" in b || "lo" in b)) {
      out.push(b);
    } else {
      const c = complete(b as SheetBooking);
      if (c) out.push({ start: c.start, end: c.end, lo: c.lo, hi: c.hi });
    }
  }
  return out;
}

function occupiesPc(b: BusyInterval, pc: number): boolean {
  if (b.pcs) return b.pcs.includes(pc);
  return b.lo !== undefined && b.hi !== undefined && pc >= b.lo && pc <= b.hi;
}

export interface AllocateOpts {
  zonePcs: number[];
  count: number;
  start: number;
  end: number;
  bookings: readonly (SheetBooking | CompleteBooking | PublicSlotSummary | BusyInterval)[];
  preferredPcs?: number[];
  strictContiguous?: boolean;
}

/**
 * Підібрати вільні ПК у зоні на інтервал [start, end).
 * За замовчуванням обирає суміжний блок за принципом best-fit (найменший придатний відрізок),
 * щоб не дробити великі суміжні групи.
 */
export function allocateContiguousPCs(opts: AllocateOpts): number[] | null {
  const { zonePcs, count, start, end, bookings, preferredPcs, strictContiguous } = opts;
  const sortedZone = [...new Set(zonePcs)].sort((a, b) => a - b);
  const overlapping = toBusyList(bookings).filter((b) => intervalsOverlap({ start, end }, b));
  const freePcs = sortedZone.filter((pc) => !overlapping.some((b) => occupiesPc(b, pc)));

  if (preferredPcs?.length) {
    const uniq = [...new Set(preferredPcs)].sort((a, b) => a - b);
    if (uniq.length !== count) return null;
    const freeSet = new Set(freePcs);
    return uniq.every((pc) => freeSet.has(pc)) ? uniq : null;
  }

  if (count <= 0 || freePcs.length < count) return null;

  // Розбиваємо на фізично суміжні серії (pc[i] === pc[i-1] + 1).
  const runs: number[][] = [];
  for (const pc of freePcs) {
    const prev = runs.at(-1);
    if (prev && prev.at(-1)! + 1 === pc) prev.push(pc);
    else runs.push([pc]);
  }

  let bestRun: number[] | null = null;
  for (const run of runs) {
    if (run.length < count) continue;
    if (!bestRun || run.length < bestRun.length || (run.length === bestRun.length && run[0]! < bestRun[0]!)) {
      bestRun = run;
    }
  }
  if (bestRun) return bestRun.slice(0, count);
  if (strictContiguous) return null;

  // Fallback: вікно з `count` вільних ПК із мінімальним розмахом номерів.
  let bestStart = 0;
  let bestSpan = Infinity;
  for (let i = 0; i <= freePcs.length - count; i++) {
    const span = freePcs[i + count - 1]! - freePcs[i]!;
    if (span < bestSpan) {
      bestSpan = span;
      bestStart = i;
    }
  }
  return freePcs.slice(bestStart, bestStart + count);
}

export interface StartTimesOpts {
  daySerial: number;
  schedule: DaySchedule[];
  zonePcs: number[];
  count: number;
  bookings: readonly (SheetBooking | CompleteBooking | PublicSlotSummary)[];
  nowAbs: number;
  stepMinutes?: number;
  minDurationMinutes?: number;
  preferredPcs?: number[];
}

/** Доступні часи початку (у хвилинах від епохи) для обраного дня, зони та кількості ПК. */
export function findAvailableStartTimes(opts: StartTimesOpts): number[] {
  const { daySerial, schedule, zonePcs, count, bookings, nowAbs, stepMinutes = 60, minDurationMinutes = 60, preferredPcs } = opts;
  const w = windowOf(schedule, daySerial);
  if (w.end <= w.start) return [];

  const relevant = toBusyList(bookings).filter((b) => b.end > w.start && b.start < w.end + minDurationMinutes);
  const out: number[] = [];
  for (let t = w.start; t < w.end; t += stepMinutes) {
    if (t < nowAbs) continue;
    if (coveredUntil(schedule, Math.floor(t / MIN_PER_DAY), t) < t + minDurationMinutes) continue;
    if (allocateContiguousPCs({ zonePcs, count, start: t, end: t + minDurationMinutes, bookings: relevant, preferredPcs })) {
      out.push(t);
    }
  }
  return out;
}

/** Публічний звіт доступності слотів (без жодних PII) для обраного дня та зони. */
export function findPublicSlotSummaries(opts: {
  daySerial: number;
  schedule: DaySchedule[];
  zone: string;
  zonePcs: number[];
  count?: number;
  busySlots: readonly PublicSlotSummary[];
  nowAbs: number;
  stepMinutes?: number;
  minDurationMinutes?: number;
}): PublicSlotSummary[] {
  const { daySerial, schedule, zone, zonePcs, count = 1, busySlots, nowAbs, stepMinutes = 60, minDurationMinutes = 60 } = opts;
  const w = windowOf(schedule, daySerial);
  if (w.end <= w.start) return [];

  const relevant = toBusyList(busySlots).filter((b) => b.end > w.start && b.start < w.end + minDurationMinutes);
  const sortedZone = [...new Set(zonePcs)].sort((a, b) => a - b);
  const out: PublicSlotSummary[] = [];

  for (let t = w.start; t < w.end; t += stepMinutes) {
    if (t < nowAbs) continue;
    if (coveredUntil(schedule, Math.floor(t / MIN_PER_DAY), t) < t + minDurationMinutes) continue;
    const end = t + minDurationMinutes;
    const overlapping = relevant.filter((b) => intervalsOverlap({ start: t, end }, b));
    const freePcs = sortedZone.filter((pc) => !overlapping.some((b) => occupiesPc(b, pc)));
    const canFit = allocateContiguousPCs({ zonePcs: sortedZone, count, start: t, end, bookings: overlapping }) !== null;
    out.push({
      date: Math.floor(t / MIN_PER_DAY),
      start: t,
      end,
      zone,
      pcs: freePcs,
      status: canFit ? "free" : "busy",
      freeCount: freePcs.length,
    });
  }
  return out;
}

export interface DurationOption {
  minutes: number;
  endAbs: number;
  toClose: boolean;
  pcs: number[];
}

export interface DurationsOpts {
  startAbs: number;
  schedule: DaySchedule[];
  zonePcs: number[];
  count: number;
  bookings: readonly (SheetBooking | CompleteBooking | PublicSlotSummary)[];
  preferredPcs?: number[];
  standardHours?: number[];
}

/** Доступні тривалості від `startAbs` з урахуванням закриття клубу та наступних броней. */
export function findAvailableDurations(opts: DurationsOpts): DurationOption[] {
  const { startAbs, schedule, zonePcs, count, bookings, preferredPcs, standardHours = [1, 2, 3, 4, 5] } = opts;
  const openWin = openWindowAt(schedule, startAbs);
  if (!openWin) return [];

  const maxCovered = coveredUntil(schedule, Math.floor(startAbs / MIN_PER_DAY), startAbs);
  const relevant = toBusyList(bookings).filter((b) => b.end > startAbs && b.start < maxCovered);
  const options: DurationOption[] = [];

  for (const h of standardHours) {
    const minutes = h * 60;
    const endAbs = startAbs + minutes;
    if (minutes > MIN_PER_DAY || endAbs > maxCovered) continue;
    const pcs = allocateContiguousPCs({ zonePcs, count, start: startAbs, end: endAbs, bookings: relevant, preferredPcs });
    if (pcs) options.push({ minutes, endAbs, toClose: false, pcs });
  }

  // «До закриття»: якщо зміна не цілодобова або наступний день зачинений.
  if (openWin.end - openWin.start < MIN_PER_DAY || maxCovered === openWin.end) {
    const closeAbs = openWin.end;
    const toCloseMin = closeAbs - startAbs;
    if (toCloseMin >= 60 && toCloseMin <= MIN_PER_DAY) {
      const existing = options.find((o) => o.minutes === toCloseMin);
      if (existing) existing.toClose = true;
      else {
        const pcs = allocateContiguousPCs({ zonePcs, count, start: startAbs, end: closeAbs, bookings: relevant, preferredPcs });
        if (pcs) options.push({ minutes: toCloseMin, endAbs: closeAbs, toClose: true, pcs });
      }
    }
  }

  return options.sort((a, b) => a.minutes - b.minutes);
}
