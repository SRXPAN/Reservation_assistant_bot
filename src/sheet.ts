// Робота з Google Таблицею: читання «Налаштування» і «Бронювання», запис і очищення броні.
//
// Правила (див. SPEC.md):
// - бот пише лише A–H і U; I–T — формули таблиці;
// - новий запис — у перший рядок від 10-го, де A, B і F порожні (values.append не використовуємо);
// - дата/час — числами, текст — як є, усе через valueInputOption=RAW;
// - запис під замком у D1, після запису перечитуємо рядок і перевіряємо свій ID;
// - рядок шукаємо за ID у колонці U, а не за номером.

import {
  FIRST_ROW,
  LAST_ROW,
  bookingInterval,
  complete,
  findConflicts,
  freeRows,
  parseBookingRows,
  pcsInRange,
  rowValues,
  splitIntoRuns,
  toPublicBusySlots,
  type NewBooking,
  type PublicSlotSummary,
  type SheetBooking,
} from "./bookings";
import type { Env } from "./config";
import { cacheDelete, cacheGet, cachePut, withLock } from "./db";
import { getAccessToken, resetTokenMemory, type FetchFn } from "./google";
import { isWithinHours, parseSchedule, type DaySchedule } from "./hours";
import { getAuthorizedClientBooking, listClientBookings } from "./store";
import { fractionToMinutes } from "./time";

export const BOOKINGS = "Бронювання";
export const SETTINGS = "Налаштування";
export const ID_HEADER = "ID бота";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const SETTINGS_CACHE_KEY = "sheet_settings";
const SETTINGS_TTL_MS = 10 * 60_000;
const WRITE_LOCK = "sheet_write";

const range = (sheet: string, a1: string) => `'${sheet}'!${a1}`;

export interface SheetCtx {
  db: D1Database;
  sheetId: string;
  saKey: string;
  fetch?: FetchFn;
}

export interface Settings {
  /** Розклад на тиждень, Пн = 0. */
  schedule: DaySchedule[];
  /** Номери ПК у порядку аркуша. */
  pcList: number[];
  /** Зона кожного ПК (Regular / Stream). */
  zones: Record<number, string>;
  /** «Цілодобові дні: розклад з» (C15), хвилини. */
  firstHour: number;
}

export class SheetApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class SheetFullError extends Error {
  constructor(need: number) {
    super(`У таблиці немає ${need} вільних рядків (до ${LAST_ROW}-го) — запис не зроблено`);
  }
}

export class WriteVerifyError extends Error {}

export class BookingConflictError extends Error {
  constructor(readonly busySlots: PublicSlotSummary[]) {
    super("Обрані ПК вже зайнято на цей час");
  }
}

export class BookingOutOfHoursError extends Error {
  constructor() {
    super("Обраний час виходить за межі робочих годин клубу");
  }
}

/** Запит до Sheets API з токеном. На 401 — один повтор зі свіжим токеном. */
async function call<T>(ctx: SheetCtx, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const fetchFn = ctx.fetch ?? fetch;
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken(ctx.db, ctx.saKey, fetchFn);
    const res = await fetchFn(`${API}/${ctx.sheetId}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (res.status === 401 && attempt === 0) {
      resetTokenMemory();
      await cacheDelete(ctx.db, "google_token");
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new SheetApiError(res.status, `Google Sheets ${res.status}: ${body.error?.message ?? "помилка"}`);
    return body;
  }
}

/** Кілька діапазонів одним запитом, без форматування: дати — серійні числа, час — частки доби. */
export async function batchGet(ctx: SheetCtx, ranges: string[]): Promise<unknown[][][]> {
  const q = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" });
  for (const r of ranges) q.append("ranges", r);
  const body = await call<{ valueRanges?: { values?: unknown[][] }[] }>(ctx, `/values:batchGet?${q}`);
  return ranges.map((_, i) => body.valueRanges?.[i]?.values ?? []);
}

async function batchUpdate(ctx: SheetCtx, data: { range: string; values: unknown[][] }[], input: "RAW" | "USER_ENTERED" = "RAW") {
  await call(ctx, "/values:batchUpdate", { method: "POST", body: { valueInputOption: input, data } });
}

async function batchClear(ctx: SheetCtx, ranges: string[]) {
  await call(ctx, "/values:batchClear", { method: "POST", body: { ranges } });
}

/* ───────────────────────── читання ───────────────────────── */

const SETTINGS_RANGES = [range(SETTINGS, "A5:D11"), range(SETTINGS, "A19:B47"), range(SETTINGS, "C15")];

function parseSettings([hours, pcs, first]: unknown[][][]): Settings {
  const pcList: number[] = [];
  const zones: Record<number, string> = {};
  for (const row of pcs ?? []) {
    const pc = row[0];
    if (typeof pc === "number" && Number.isInteger(pc)) {
      pcList.push(pc);
      zones[pc] = String(row[1] ?? "").trim();
    }
  }
  const fh = first?.[0]?.[0];
  return {
    schedule: parseSchedule(hours ?? []),
    pcList,
    zones,
    // C15 може бути часом (частка доби, «12:00») або числом годин (12); 0 = з 00:00.
    firstHour: typeof fh !== "number" ? 0 : fh < 1 ? fractionToMinutes(fh) : Math.round(fh * 60) % 1440,
  };
}

/** Налаштування з кешем у D1 на 10 хв (`fresh` — прочитати таблицю заново). */
export async function loadSettings(ctx: SheetCtx, opts: { fresh?: boolean } = {}): Promise<Settings> {
  if (!opts.fresh) {
    const cached = await cacheGet(ctx.db, SETTINGS_CACHE_KEY);
    if (cached) return JSON.parse(cached) as Settings;
  }
  const settings = parseSettings(await batchGet(ctx, SETTINGS_RANGES));
  await cachePut(ctx.db, SETTINGS_CACHE_KEY, JSON.stringify(settings), SETTINGS_TTL_MS);
  return settings;
}

export interface Snapshot {
  bookings: SheetBooking[];
  /** Понеділок тижня, вибраного в таблиці (F3 = WeekMon). */
  weekMon: number;
  settings: Settings;
}

/** Броні завжди свіжі (тільки для адмінів); налаштування — з кешу, а якщо його немає — тим самим запитом. */
export async function readSnapshot(ctx: SheetCtx): Promise<Snapshot> {
  const cached = await cacheGet(ctx.db, SETTINGS_CACHE_KEY);
  const ranges = [range(BOOKINGS, `A${FIRST_ROW}:U${LAST_ROW}`), range(BOOKINGS, "F3"), ...(cached ? [] : SETTINGS_RANGES)];
  const [rows, week, ...rest] = await batchGet(ctx, ranges);
  let settings: Settings;
  if (cached) settings = JSON.parse(cached) as Settings;
  else {
    settings = parseSettings(rest);
    await cachePut(ctx.db, SETTINGS_CACHE_KEY, JSON.stringify(settings), SETTINGS_TTL_MS);
  }
  const wm = week?.[0]?.[0];
  return { bookings: parseBookingRows(rows ?? []), weekMon: typeof wm === "number" ? Math.floor(wm) : 0, settings };
}

/** Публічний знімок доступності для клієнтів: виключно `PublicSlotSummary[]` без жодних PII. */
export async function readPublicSnapshot(ctx: SheetCtx): Promise<{ busySlots: PublicSlotSummary[]; settings: Settings }> {
  const snap = await readSnapshot(ctx);
  return {
    busySlots: toPublicBusySlots(snap.bookings, snap.settings.pcList, snap.settings.zones),
    settings: snap.settings,
  };
}

/** Власна бронь клієнта (повертається лише власнику після SQL-перевірки `client_tg_id`). */
export interface ClientOwnBooking {
  id: string;
  date: number;
  start: number;
  end: number;
  pcs: number[];
  zone: string;
  name: string;
  contact: string;
}

function groupClientOwnBookings(bookings: SheetBooking[], allowedIds: Set<string>, settings: Settings): ClientOwnBooking[] {
  const byId = new Map<string, ClientOwnBooking>();
  for (const raw of bookings) {
    if (!raw.botId || !allowedIds.has(raw.botId)) continue;
    const b = complete(raw);
    if (!b) continue;
    const pcs = pcsInRange(settings.pcList, b.lo, b.hi);
    const list = pcs.length ? pcs : [b.lo];
    const existing = byId.get(raw.botId);
    if (existing) {
      existing.pcs = [...new Set([...existing.pcs, ...list])].sort((x, y) => x - y);
      existing.zone = [...new Set(existing.pcs.map((pc) => (settings.zones[pc] ?? "").trim()).filter(Boolean))].join(" + ");
      continue;
    }
    const zone = [...new Set(list.map((pc) => (settings.zones[pc] ?? "").trim()).filter(Boolean))].join(" + ");
    byId.set(raw.botId, {
      id: raw.botId,
      date: b.date,
      start: b.start,
      end: b.end,
      pcs: list,
      zone,
      name: b.name,
      contact: b.contact,
    });
  }
  return [...byId.values()].sort((a, b) => a.start - b.start || a.pcs[0]! - b.pcs[0]!);
}

/** Прочитати лише власні активні броні клієнта (фільтрація в SQL за `client_tg_id`). */
export async function readClientOwnBookings(
  ctx: SheetCtx,
  db: D1Database,
  clientTgId: number,
  nowAbsVal?: number,
): Promise<{ bookings: ClientOwnBooking[]; settings: Settings }> {
  const mine = await listClientBookings(db, clientTgId);
  if (!mine.length) return { bookings: [], settings: await loadSettings(ctx) };
  const allowedIds = new Set(mine.map((r) => r.booking_id));
  const snap = await readSnapshot(ctx);
  const allOwn = groupClientOwnBookings(snap.bookings, allowedIds, snap.settings);
  const bookings = nowAbsVal === undefined ? allOwn : allOwn.filter((b) => b.end > nowAbsVal);
  return { bookings, settings: snap.settings };
}

/** Авторизоване читання конкретної броні за ID з перевіркою власника або ролі адміністратора. */
export async function readAuthorizedClientBooking(
  ctx: SheetCtx,
  db: D1Database,
  bookingId: string,
  userId: number,
  env: Env,
): Promise<{ booking: ClientOwnBooking; ownerTgId: number; settings: Settings } | null> {
  const row = await getAuthorizedClientBooking(db, bookingId, userId, env);
  if (!row) return null;
  const snap = await readSnapshot(ctx);
  const list = groupClientOwnBookings(snap.bookings, new Set([bookingId]), snap.settings);
  const booking = list[0];
  if (!booking) return null;
  return { booking, ownerTgId: row.client_tg_id, settings: snap.settings };
}

/** Рядки, у колонці U яких стоїть цей ID. */
export async function findRowsById(ctx: SheetCtx, id: string): Promise<number[]> {
  const [col] = await batchGet(ctx, [range(BOOKINGS, `U${FIRST_ROW}:U${LAST_ROW}`)]);
  const rows: number[] = [];
  (col ?? []).forEach((r, i) => {
    if (String(r[0] ?? "").trim() === id) rows.push(FIRST_ROW + i);
  });
  return rows;
}

/* ───────────────────────── запис ───────────────────────── */

export interface WriteResult {
  id: string;
  rows: number[];
  /** Статус K кожного записаного рядка (як порахувала таблиця). */
  statuses: string[];
}

/*
 * Час (виміряно на живій таблиці 19.11.2026): сам запис і очищення — ~0,7 с, але ПЕРШЕ читання
 * після будь-якої зміни чекає, поки Google перерахує формули всієї таблиці, — ~17 с.
 * Тому під замком лише «знайти вільні рядки + записати»: наступний записувач однаково побачить
 * наш рядок зайнятим (читання після запису узгоджене, просто повільне). Перечитування U/K — без замка.
 */
const LOCK_OPTS = { ttlMs: 60_000, waitMs: 12_000, stepMs: 500 };

/**
 * Записати бронь у вільні рядки (швидко, під замком). Несуміжні ПК → кілька рядків з одним ID.
 * Повертає номери рядків; перевірку робить `verifyBooking`.
 */
export async function placeBooking(ctx: SheetCtx, booking: NewBooking, id: string, pcList: number[]): Promise<number[]> {
  const runs = splitIntoRuns(booking.pcs, pcList);
  if (!runs.length) throw new Error("Жодного ПК зі списку «Налаштування» не вибрано");

  return withLock(ctx.db, WRITE_LOCK, async () => {
    const [ab, f] = await batchGet(ctx, [range(BOOKINGS, `A${FIRST_ROW}:B${LAST_ROW}`), range(BOOKINGS, `F${FIRST_ROW}:F${LAST_ROW}`)]);
    const cells = Array.from({ length: LAST_ROW - FIRST_ROW + 1 }, (_, i) => ({
      a: ab?.[i]?.[0],
      b: ab?.[i]?.[1],
      f: f?.[i]?.[0],
    }));
    const rows = freeRows(cells).slice(0, runs.length);
    if (rows.length < runs.length) throw new SheetFullError(runs.length);

    await batchUpdate(
      ctx,
      rows.flatMap((row, i) => [
        { range: range(BOOKINGS, `A${row}:H${row}`), values: [rowValues(booking, runs[i]!)] },
        { range: range(BOOKINGS, `U${row}`), values: [[id]] },
      ]),
    );
    return rows;
  }, LOCK_OPTS);
}

/**
 * Атомарний запис клієнтської броні під замком D1:
 * перечитує свіжу таблицю, перевіряє години й накладки, і лише тоді записує у вільні рядки.
 */
export async function placeClientBooking(
  ctx: SheetCtx,
  booking: NewBooking,
  id: string,
  pcList: number[],
  schedule: DaySchedule[],
  zones: Record<number, string> = {},
): Promise<number[]> {
  const runs = splitIntoRuns(booking.pcs, pcList);
  if (!runs.length) throw new Error("Жодного ПК зі списку «Налаштування» не вибрано");

  return withLock(ctx.db, WRITE_LOCK, async () => {
    const [raw] = await batchGet(ctx, [range(BOOKINGS, `A${FIRST_ROW}:U${LAST_ROW}`)]);
    const freshBookings = parseBookingRows(raw ?? []);
    const { start, end } = bookingInterval(booking.date, booking.from, booking.to);
    if (!isWithinHours(schedule, booking.date, start, end)) throw new BookingOutOfHoursError();
    const conflicts = findConflicts({ pcs: booking.pcs, start, end }, freshBookings);
    if (conflicts.length) throw new BookingConflictError(toPublicBusySlots(freshBookings, pcList, zones));

    const cells = Array.from({ length: LAST_ROW - FIRST_ROW + 1 }, (_, i) => ({
      a: raw?.[i]?.[0],
      b: raw?.[i]?.[1],
      f: raw?.[i]?.[5],
    }));
    const rows = freeRows(cells).slice(0, runs.length);
    if (rows.length < runs.length) throw new SheetFullError(runs.length);

    await batchUpdate(
      ctx,
      rows.flatMap((row, i) => [
        { range: range(BOOKINGS, `A${row}:H${row}`), values: [rowValues(booking, runs[i]!)] },
        { range: range(BOOKINGS, `U${row}`), values: [[id]] },
      ]),
    );
    return rows;
  }, LOCK_OPTS);
}

/**
 * Перечитати бронь після запису (повільно, ~17 с): знайти рядки з нашим ID і їхні статуси K.
 * Шукаємо за ID, а не за номерами: за ці секунди рядки могли пересортувати.
 * `expected` — скільки рядків має бути; менше — помилка (хтось перезаписав або видалив).
 */
export async function verifyBooking(ctx: SheetCtx, id: string, expected: number): Promise<{ rows: number[]; statuses: string[] }> {
  const [k, u] = await batchGet(ctx, [range(BOOKINGS, `K${FIRST_ROW}:K${LAST_ROW}`), range(BOOKINGS, `U${FIRST_ROW}:U${LAST_ROW}`)]);
  const rows: number[] = [];
  const statuses: string[] = [];
  (u ?? []).forEach((r, i) => {
    if (String(r[0] ?? "").trim() !== id) return;
    rows.push(FIRST_ROW + i);
    statuses.push(String(k?.[i]?.[0] ?? ""));
  });
  if (rows.length < expected) {
    throw new WriteVerifyError(
      rows.length ? `Після запису знайдено ${rows.length} з ${expected} рядків броні` : "Після запису рядка з цим ID у таблиці не знайдено",
    );
  }
  return { rows, statuses };
}

/** Записати і перевірити (place + verify). */
export async function writeBooking(ctx: SheetCtx, booking: NewBooking, id: string, pcList: number[]): Promise<WriteResult> {
  const placed = await placeBooking(ctx, booking, id, pcList);
  const { rows, statuses } = await verifyBooking(ctx, id, placed.length);
  return { id, rows, statuses };
}

/** Броні з таким ID у таблиці немає — рядок видалили вручну. */
export class BookingMissingError extends Error {
  constructor() {
    super("У таблиці цієї броні вже немає — схоже, рядок видалили вручну");
  }
}

/**
 * Замінити вже записану бронь новими значеннями (той самий ID). Рядки беремо ті, де бронь уже стоїть;
 * якщо після зміни рядків треба більше — додаємо вільні, якщо менше — зайві очищаємо.
 */
export async function replaceBooking(ctx: SheetCtx, booking: NewBooking, id: string, pcList: number[]): Promise<number[]> {
  const runs = splitIntoRuns(booking.pcs, pcList);
  if (!runs.length) throw new Error("Жодного ПК зі списку «Налаштування» не вибрано");

  return withLock(ctx.db, WRITE_LOCK, async () => {
    const [ab, f, u] = await batchGet(ctx, [
      range(BOOKINGS, `A${FIRST_ROW}:B${LAST_ROW}`),
      range(BOOKINGS, `F${FIRST_ROW}:F${LAST_ROW}`),
      range(BOOKINGS, `U${FIRST_ROW}:U${LAST_ROW}`),
    ]);
    const own: number[] = [];
    (u ?? []).forEach((r, i) => {
      if (String(r[0] ?? "").trim() === id) own.push(FIRST_ROW + i);
    });
    if (!own.length) throw new BookingMissingError();
    const rows = own.slice(0, runs.length);
    if (rows.length < runs.length) {
      const cells = Array.from({ length: LAST_ROW - FIRST_ROW + 1 }, (_, i) => ({ a: ab?.[i]?.[0], b: ab?.[i]?.[1], f: f?.[i]?.[0] }));
      const extra = freeRows(cells).filter((r) => !own.includes(r));
      rows.push(...extra.slice(0, runs.length - rows.length));
      if (rows.length < runs.length) throw new SheetFullError(runs.length - own.length);
    }
    await batchUpdate(
      ctx,
      rows.flatMap((row, i) => [
        { range: range(BOOKINGS, `A${row}:H${row}`), values: [rowValues(booking, runs[i]!)] },
        { range: range(BOOKINGS, `U${row}`), values: [[id]] },
      ]),
    );
    const leftover = own.slice(runs.length);
    if (leftover.length) {
      await batchClear(ctx, leftover.flatMap((row) => [range(BOOKINGS, `A${row}:H${row}`), range(BOOKINGS, `U${row}`)]));
    }
    return rows;
  }, LOCK_OPTS);
}

/** Скасувати бронь: очистити A–H і U у всіх рядках з цим ID. Повертає номери очищених рядків. */
export async function clearBooking(ctx: SheetCtx, id: string): Promise<number[]> {
  return withLock(ctx.db, WRITE_LOCK, async () => {
    const rows = await findRowsById(ctx, id);
    if (rows.length) {
      await batchClear(ctx, rows.flatMap((row) => [range(BOOKINGS, `A${row}:H${row}`), range(BOOKINGS, `U${row}`)]));
    }
    return rows;
  }, LOCK_OPTS);
}

/**
 * Змінити примітку (H) у рядках, які вибере `find` зі свіжої таблиці (під замком).
 * Повертає номери змінених рядків; порожній масив — броні в таблиці вже немає.
 */
export async function updateNotes(
  ctx: SheetCtx,
  find: (bookings: SheetBooking[]) => SheetBooking[],
  transform: (note: string) => string,
): Promise<number[]> {
  return withLock(ctx.db, WRITE_LOCK, async () => {
    const [rows] = await batchGet(ctx, [range(BOOKINGS, `A${FIRST_ROW}:U${LAST_ROW}`)]);
    const targets = find(parseBookingRows(rows ?? []));
    if (targets.length) {
      await batchUpdate(ctx, targets.map((b) => ({ range: range(BOOKINGS, `H${b.row}`), values: [[transform(b.note)]] })));
    }
    return targets.map((b) => b.row);
  }, LOCK_OPTS);
}

/** Заголовок U9 «ID бота» — записується, лише якщо клітинка порожня. Повертає, чи довелося писати. */
export async function ensureIdHeader(ctx: SheetCtx): Promise<boolean> {
  const [cell] = await batchGet(ctx, [range(BOOKINGS, "U9")]);
  const current = String(cell?.[0]?.[0] ?? "").trim();
  if (current === ID_HEADER) return false;
  if (current) throw new Error(`U9 уже зайнята: «${current}» — не перезаписую`);
  await batchUpdate(ctx, [{ range: range(BOOKINGS, "U9"), values: [[ID_HEADER]] }]);
  return true;
}

/** Службове: записати довільні клітинки (для живої перевірки — перемикач тижня B3). */
export async function writeCells(ctx: SheetCtx, data: { range: string; values: unknown[][] }[], input: "RAW" | "USER_ENTERED") {
  await batchUpdate(ctx, data, input);
}

export const sheetRange = range;
