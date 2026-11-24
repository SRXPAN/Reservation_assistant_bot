import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tryLock } from "../src/db";
import { resetTokenMemory } from "../src/google";
import {
  BOOKINGS,
  BookingConflictError,
  BookingMissingError,
  BookingOutOfHoursError,
  SETTINGS,
  SheetFullError,
  placeBooking,
  placeClientBooking,
  replaceBooking,
  verifyBooking,
  WriteVerifyError,
  clearBooking,
  ensureIdHeader,
  findRowsById,
  loadSettings,
  readClientOwnBookings,
  readPublicSnapshot,
  readSnapshot,
  writeBooking,
  type SheetCtx,
} from "../src/sheet";
import { saveClientBooking } from "../src/store";
import { dateToSerial } from "../src/time";
import { FakeGoogle, makeServiceAccountKey } from "./fakeSheets";
import { CLUB_HOURS_ROWS, PC_LIST, fakeD1, sheetRow } from "./helpers";

let rawKey: string;
beforeAll(async () => {
  rawKey = (await makeServiceAccountKey()).raw;
});

const TUE = dateToSerial(2026, 11, 24);
let google: FakeGoogle;
let ctx: SheetCtx;

beforeEach(() => {
  resetTokenMemory();
  google = new FakeGoogle();
  ctx = { db: fakeD1(), sheetId: "SHEET", saKey: rawKey, fetch: google.fetch };
  CLUB_HOURS_ROWS.forEach((r, i) => google.setRow(SETTINGS, 5 + i, r));
  PC_LIST.forEach((pc, i) => google.setRow(SETTINGS, 19 + i, [pc, pc === 18 || pc === 19 ? "Stream" : "Regular"]));
  google.set(SETTINGS, 15, 2, 0.5);
  google.set(BOOKINGS, 3, 5, dateToSerial(2026, 11, 16));
  // Рядки 10–11 зайняті прикладами.
  google.setRow(BOOKINGS, 10, sheetRow({ date: 46337, b: 18, from: "16:00", to: "19:00", name: "Андрій" }));
  google.setRow(BOOKINGS, 11, sheetRow({ date: 46337, b: 12, from: "22:00", to: "00:00", name: "Марта" }));
});

const booking = (pcs: number[]) => ({
  date: TUE,
  pcs,
  from: 18 * 60,
  to: 2 * 60,
  name: "Vova",
  contact: "+48 501 234 567",
  note: "день народження",
});

describe("читання", () => {
  it("налаштування: розклад, ПК, зони, «розклад з»; кеш у D1", async () => {
    const s = await loadSettings(ctx);
    expect(s.pcList).toEqual(PC_LIST);
    expect(s.zones[18]).toBe("Stream");
    expect(s.schedule[3]).toMatchObject({ start: 720, end: 1800 });
    expect(s.firstHour).toBe(720);
    const before = google.calls.length;
    await loadSettings(ctx);
    expect(google.calls.length).toBe(before); // з кешу
  });

  it("знімок: броні + понеділок вибраного тижня одним batchGet", async () => {
    const snap = await readSnapshot(ctx);
    expect(snap.bookings.map((b) => b.name)).toEqual(["Андрій", "Марта"]);
    expect(snap.weekMon).toBe(dateToSerial(2026, 11, 16));
    const gets = google.calls.filter((c) => c.url.includes("batchGet"));
    expect(gets).toHaveLength(1);
    expect(gets[0]!.url).toContain("valueRenderOption=UNFORMATTED_VALUE");
    expect(gets[0]!.url).toContain("dateTimeRenderOption=SERIAL_NUMBER");
  });
});

describe("запис броні", () => {
  it("у перший вільний рядок, A–H + U через RAW, з перевіркою ID і статусом K", async () => {
    // Рядок 12: лишився ID від старої броні, але A, B, F порожні — вважається вільним.
    google.set(BOOKINGS, 12, 20, "R-stale");
    const res = await writeBooking(ctx, booking([12, 13, 14, 15, 16, 17]), "R-1", PC_LIST);
    expect(res).toEqual({ id: "R-1", rows: [12], statuses: ["✓ OK"] });

    const upd = google.calls.find((c) => c.url.includes("batchUpdate"))!;
    expect(upd.body.valueInputOption).toBe("RAW");
    expect(upd.body.data).toEqual([
      { range: `'${BOOKINGS}'!A12:H12`, values: [[TUE, 12, 17, 0.75, 2 / 24, "Vova", "+48 501 234 567", "день народження"]] },
      { range: `'${BOOKINGS}'!U12`, values: [["R-1"]] },
    ]);
    // Формули I–T ніхто не чіпає (крім фейкового K, який «рахує таблиця»).
    expect(upd.body.data.every((d: { range: string }) => /!(A\d+:H\d+|U\d+)$/.test(d.range))).toBe(true);
  });

  it("несуміжні ПК — кілька рядків з одним ID; дірки між зайнятими рядками заповнюються", async () => {
    google.setRow(BOOKINGS, 13, sheetRow({ date: TUE, b: 1, from: "12:00", to: "13:00", name: "Хтось" }));
    const res = await writeBooking(ctx, booking([12, 14, 16]), "R-2", PC_LIST);
    expect(res.rows).toEqual([12, 14, 15]);
    expect(await findRowsById(ctx, "R-2")).toEqual([12, 14, 15]);
    expect(google.get(BOOKINGS, 12, 2)).toBeUndefined(); // C порожня для одного ПК
  });

  it("якщо в рядок після запису потрапив чужий ID — помилка, а не тиха втрата", async () => {
    google.onUpdate = () => {
      google.onUpdate = undefined;
      queueMicrotask(() => google.set(BOOKINGS, 12, 20, "R-чужий"));
    };
    await expect(writeBooking(ctx, booking([5]), "R-3", PC_LIST)).rejects.toThrow(WriteVerifyError);
  });

  it("таблиця заповнена — не пишемо нічого", async () => {
    for (let row = 12; row <= 1009; row++) google.set(BOOKINGS, row, 0, TUE);
    await expect(writeBooking(ctx, booking([5]), "R-4", PC_LIST)).rejects.toThrow(SheetFullError);
    expect(google.calls.some((c) => c.url.includes("batchUpdate"))).toBe(false);
  });

  it("два записи одночасно отримують різні рядки (замок у D1)", async () => {
    const [a, b] = await Promise.all([
      writeBooking(ctx, booking([1]), "R-a", PC_LIST),
      writeBooking(ctx, booking([2]), "R-b", PC_LIST),
    ]);
    expect(new Set([...a.rows, ...b.rows]).size).toBe(2);
  });

  it("зайнятий замок → після очікування зрозуміла помилка", async () => {
    expect(await tryLock(ctx.db, "sheet_write", "інший", 60_000)).toBe(true);
    const { withLock } = await import("../src/db");
    await expect(withLock(ctx.db, "sheet_write", async () => 1, { waitMs: 300, stepMs: 100 })).rejects.toThrow(/інший адміністратор/);
  });
});

describe("скасування броні", () => {
  it("очищує A–H і U лише рядків з цим ID, навіть якщо рядки пересортували", async () => {
    await writeBooking(ctx, booking([12, 14]), "R-5", PC_LIST);
    // Людина пересортувала: бронь переїхала з рядків 12–13 у 20–21.
    for (const [from, to] of [
      [12, 20],
      [13, 21],
    ] as const) {
      for (let c = 0; c <= 20; c++) {
        const v = google.get(BOOKINGS, from, c);
        google.set(BOOKINGS, from, c, "");
        if (v !== undefined) google.set(BOOKINGS, to, c, v);
      }
    }
    google.setRow(BOOKINGS, 12, sheetRow({ date: TUE, b: 3, from: "12:00", to: "13:00", name: "Ручна" }));

    expect(await clearBooking(ctx, "R-5")).toEqual([20, 21]);
    const clr = google.calls.find((c) => c.url.includes("batchClear"))!;
    expect(clr.body.ranges).toEqual([`'${BOOKINGS}'!A20:H20`, `'${BOOKINGS}'!U20`, `'${BOOKINGS}'!A21:H21`, `'${BOOKINGS}'!U21`]);
    expect(google.get(BOOKINGS, 12, 5)).toBe("Ручна");
    expect(await findRowsById(ctx, "R-5")).toEqual([]);
  });
});

describe("перевірка після запису шукає за ID", () => {
  it("рядок пересортували між записом і перечитуванням — знаходимо новий номер", async () => {
    const rows = await placeBooking(ctx, booking([5]), "R-v", PC_LIST);
    expect(rows).toEqual([12]);
    for (let c = 0; c <= 20; c++) {
      const v = google.get(BOOKINGS, 12, c);
      google.set(BOOKINGS, 12, c, "");
      if (v !== undefined) google.set(BOOKINGS, 30, c, v);
    }
    expect(await verifyBooking(ctx, "R-v", 1)).toEqual({ rows: [30], statuses: ["✓ OK"] });
    await expect(verifyBooking(ctx, "R-немає", 1)).rejects.toThrow(/не знайдено/);
  });

  it("заміна броні, якої вже немає в таблиці, — зрозуміла помилка, нічого не записано", async () => {
    await expect(replaceBooking(ctx, booking([5]), "R-зник", PC_LIST)).rejects.toThrow(BookingMissingError);
    expect(google.calls.some((c) => c.url.includes("batchUpdate"))).toBe(false);
  });
});

describe("заголовок U9", () => {
  it("пише «ID бота» лише в порожню клітинку", async () => {
    expect(await ensureIdHeader(ctx)).toBe(true);
    expect(google.get(BOOKINGS, 9, 20)).toBe("ID бота");
    expect(await ensureIdHeader(ctx)).toBe(false);
    google.set(BOOKINGS, 9, 20, "Щось інше");
    await expect(ensureIdHeader(ctx)).rejects.toThrow(/U9 уже зайнята/);
  });
});

describe("атомарний клієнтський запис під замком і ізоляція читання", () => {
  it("перевіряє свіжу таблицю на накладку і години перед записом; BookingConflictError без PII", async () => {
    const settings = await loadSettings(ctx);
    // У таблиці вже є бронь на вт ПК 5 18:00–20:00
    google.setRow(BOOKINGS, 12, sheetRow({ date: TUE, b: 5, from: "18:00", to: "20:00", name: "ЧужеІм'я", contact: "+48 999 888 777" }));
    let caught: unknown;
    try {
      await placeClientBooking(
        ctx,
        { date: TUE, pcs: [5], from: 19 * 60, to: 21 * 60, name: "Клієнт", contact: "@u", note: "клієнт через бот" },
        "R-cl-1",
        PC_LIST,
        settings.schedule,
        settings.zones,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BookingConflictError);
    expect(JSON.stringify((caught as BookingConflictError).busySlots)).not.toContain("ЧужеІм'я");
    expect(JSON.stringify((caught as BookingConflictError).busySlots)).not.toContain("999 888");

    // Поза годинами роботи (вт о 09:00)
    await expect(
      placeClientBooking(
        ctx,
        { date: TUE, pcs: [5], from: 9 * 60, to: 11 * 60, name: "Клієнт", contact: "@u", note: "клієнт через бот" },
        "R-cl-2",
        PC_LIST,
        settings.schedule,
        settings.zones,
      ),
    ).rejects.toThrow(BookingOutOfHoursError);

    // Вільний слот 20:00–22:00 записується успішно
    const rows = await placeClientBooking(
      ctx,
      { date: TUE, pcs: [5], from: 20 * 60, to: 22 * 60, name: "Клієнт", contact: "@u", note: "клієнт через бот" },
      "R-cl-3",
      PC_LIST,
      settings.schedule,
      settings.zones,
    );
    expect(rows).toEqual([13]);
    expect(google.get(BOOKINGS, 13, 20)).toBe("R-cl-3");

    // readPublicSnapshot не містить жодних PII; readClientOwnBookings повертає лише броні цього user_id
    await saveClientBooking(ctx.db, "R-cl-3", 777);
    const pub = await readPublicSnapshot(ctx);
    expect(JSON.stringify(pub.busySlots)).not.toContain("ЧужеІм'я");
    expect(JSON.stringify(pub.busySlots)).not.toContain("Клієнт");

    const own777 = await readClientOwnBookings(ctx, ctx.db, 777);
    expect(own777.bookings.map((b) => b.id)).toEqual(["R-cl-3"]);
    const own888 = await readClientOwnBookings(ctx, ctx.db, 888);
    expect(own888.bookings).toEqual([]);
  });
});
