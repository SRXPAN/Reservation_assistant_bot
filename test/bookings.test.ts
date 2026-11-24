import { describe, expect, it } from "vitest";
import {
  allocateContiguousPCs,
  availableZones,
  bookingInterval,
  complete,
  expectedStatus,
  findAvailableDurations,
  findAvailableStartTimes,
  findConflicts,
  findPublicSlotSummaries,
  freeRows,
  intervalToBookingTime,
  isOkStatus,
  newBookingId,
  parseBookingRows,
  rowValues,
  splitIntoRuns,
  toPublicBusySlots,
  zonePCs,
} from "../src/bookings";
import { parseSchedule } from "../src/hours";
import { dateToSerial } from "../src/time";
import { CLUB_HOURS_ROWS, PC_LIST, sheetRow } from "./helpers";

const schedule = parseSchedule(CLUB_HOURS_ROWS);
const MON = dateToSerial(2026, 11, 23);
const TUE = MON + 1;
const FRI = MON + 4;
const H = 60;

describe("інтервал броні", () => {
  it("денна бронь", () => {
    expect(bookingInterval(TUE, 18 * H, 20 * H)).toEqual({ start: TUE * 1440 + 1080, end: TUE * 1440 + 1200 });
  });
  it("«До» ≤ «Від» — наступного дня (нічна до 02:00, до 00:00, рівно 24 год)", () => {
    expect(bookingInterval(FRI, 22 * H, 2 * H).end).toBe((FRI + 1) * 1440 + 120);
    expect(bookingInterval(FRI, 22 * H, 0).end).toBe((FRI + 1) * 1440);
    expect(bookingInterval(FRI, 12 * H, 12 * H).end - bookingInterval(FRI, 12 * H, 12 * H).start).toBe(1440);
  });
});

describe("групи ПК", () => {
  it("суміжні ПК — один рядок B..C", () => {
    expect(splitIntoRuns([12, 13, 14, 15, 16, 17], PC_LIST)).toEqual([{ first: 12, last: 17 }]);
    expect(splitIntoRuns([18], PC_LIST)).toEqual([{ first: 18, last: 18 }]);
  });
  it("несуміжні ПК — кілька рядків", () => {
    expect(splitIntoRuns([12, 14, 16], PC_LIST)).toEqual([
      { first: 12, last: 12 },
      { first: 14, last: 14 },
      { first: 16, last: 16 },
    ]);
    expect(splitIntoRuns([16, 12, 13, 14], PC_LIST)).toEqual([
      { first: 12, last: 14 },
      { first: 16, last: 16 },
    ]);
  });
  it("діра в нумерації списку не розриває групу; ПК поза списком ігноруються", () => {
    const list = [1, 2, 3, 5, 6];
    expect(splitIntoRuns([3, 5], list)).toEqual([{ first: 3, last: 5 }]);
    expect(splitIntoRuns([2, 4, 40], list)).toEqual([{ first: 2, last: 2 }]);
  });

  it("значення рядка A–H: числа для дати/часу, текст як є, C порожня для одного ПК", () => {
    const b = { date: TUE, pcs: [12, 13], from: 19 * H, to: 2 * H, name: "Vova", contact: "+48 501 234 567", note: "=1+1" };
    expect(rowValues(b, { first: 12, last: 17 })).toEqual([TUE, 12, 17, 19 / 24, 2 / 24, "Vova", "+48 501 234 567", "=1+1"]);
    expect(rowValues(b, { first: 18, last: 18 })[2]).toBe("");
    expect(rowValues({ ...b, to: 1440 }, { first: 1, last: 1 })[4]).toBe(1);
  });
});

describe("рядки таблиці", () => {
  it("розбір: порожні рядки пропускаються, номери рядків зберігаються", () => {
    const rows = parseBookingRows([
      sheetRow({ date: 46337, b: 18, from: "16:00", to: "19:00", name: "Андрій", contact: "+48 501 234 567", status: "✓ інший тиждень" }),
      [],
      ["", "", "", "", "", "", "", "", "", "", "✏ ← нове бронювання тут"],
      sheetRow({ date: 46337, b: 25, c: 29, from: "12:00", to: "15:30", name: "Олег", id: "R-1" }),
    ]);
    expect(rows.map((r) => r.row)).toEqual([10, 13]);
    expect(rows[0]).toMatchObject({ date: 46337, pcB: 18, pcC: null, from: 960, to: 1140, contact: "+48 501 234 567", botId: "" });
    expect(rows[1]).toMatchObject({ pcB: 25, pcC: 29, from: 720, to: 930, botId: "R-1" });
  });

  it("вільний рядок — де A, B і F порожні (U або примітка не заважають)", () => {
    const cells = [
      { a: 46337, b: 18, f: "Андрій" },
      { a: "", b: "", f: "", u: "R-old" },
      { a: 46337, b: "", f: "" }, // почато вручну — не вільний
      { a: undefined, b: undefined, f: undefined },
    ];
    expect(freeRows(cells, 10, 14)).toEqual([11, 13, 14]);
  });

  it("група з C < B рахується як MIN..MAX", () => {
    const c = complete(parseBookingRows([sheetRow({ date: TUE, b: 17, c: 12, from: "18:00", to: "22:00" })])[0]!);
    expect(c).toMatchObject({ lo: 12, hi: 17 });
  });
});

describe("накладки", () => {
  const existing = parseBookingRows([
    sheetRow({ date: TUE, b: 14, from: "18:00", to: "20:00", name: "Андрій" }),
    sheetRow({ date: TUE, b: 12, c: 17, from: "21:00", to: "23:00", name: "Дмитро", id: "R-d" }),
    sheetRow({ date: FRI, b: 7, from: "22:00", to: "02:00", name: "Нічний" }),
  ]);

  it("перетин за ПК і часом — з ким і які ПК", () => {
    const start = TUE * 1440 + 19 * H;
    const c = findConflicts({ pcs: [13, 14, 15], start, end: start + 2 * H }, existing);
    expect(c).toHaveLength(1);
    expect(c[0]!.booking.name).toBe("Андрій");
    expect(c[0]!.pcs).toEqual([14]);
  });

  it("впритул (19–21 і 21–23) — не накладка", () => {
    const start = TUE * 1440 + 20 * H;
    expect(findConflicts({ pcs: [14], start, end: start + H }, existing)).toEqual([]);
    expect(findConflicts({ pcs: [12], start, end: start + H }, existing)).toEqual([]);
  });

  it("нічна бронь накладається на наступний день", () => {
    const start = (FRI + 1) * 1440 + 1 * H;
    expect(findConflicts({ pcs: [7], start, end: start + H }, existing)).toHaveLength(1);
    expect(findConflicts({ pcs: [7], start: start + H, end: start + 2 * H }, existing)).toEqual([]);
  });

  it("несуміжні ПК: зачіпає лише ті, що в діапазоні групи", () => {
    const start = TUE * 1440 + 22 * H;
    const c = findConflicts({ pcs: [10, 12, 16, 18], start, end: start + H }, existing);
    expect(c.map((x) => x.pcs)).toEqual([[12, 16]]);
  });

  it("власні рядки при зміні броні не рахуються", () => {
    const start = TUE * 1440 + 22 * H;
    expect(findConflicts({ pcs: [12], start, end: start + H }, existing, "R-d")).toEqual([]);
  });
});

describe("статус як у колонці K", () => {
  const WEEK = MON; // у таблиці вибраний тиждень 23–29.11
  const status = (rows: unknown[][], i: number, weekMon = WEEK) => {
    const all = parseBookingRows(rows);
    return expectedStatus(all[i]!, all, schedule, PC_LIST, weekMon);
  };

  it("✓ OK, ✓ OK · група N ПК, ✓ інший тиждень", () => {
    const rows = [
      sheetRow({ date: TUE, b: 5, from: "18:00", to: "20:00" }),
      sheetRow({ date: TUE, b: 12, c: 17, from: "18:00", to: "22:00" }),
    ];
    expect(status(rows, 0)).toBe("✓ OK");
    expect(status(rows, 1)).toBe("✓ OK · група 6 ПК");
    expect(status(rows, 0, MON - 7)).toBe("✓ інший тиждень");
    expect(isOkStatus("✓ інший тиждень")).toBe(true);
  });

  it("накладка: одна бронь / група; впритул — OK", () => {
    const rows = [
      sheetRow({ date: TUE, b: 5, from: "18:00", to: "20:00" }),
      sheetRow({ date: TUE, b: 3, c: 6, from: "19:00", to: "21:00" }),
      sheetRow({ date: TUE, b: 5, from: "21:00", to: "23:00" }),
    ];
    expect(status(rows, 0)).toBe("⚠ НАКЛАДКА: ПК вже зайнятий");
    expect(status(rows, 1)).toBe("⚠ НАКЛАДКА: ПК з групи зайнятий");
    expect(status(rows, 2)).toBe("✓ OK");
  });

  it("накладка важливіша за «поза годинами» і за «інший тиждень»", () => {
    const rows = [
      sheetRow({ date: TUE, b: 5, from: "22:00", to: "02:00" }),
      sheetRow({ date: TUE, b: 5, from: "23:00", to: "01:00" }),
    ];
    expect(status(rows, 0, MON - 7)).toBe("⚠ НАКЛАДКА: ПК вже зайнятий");
  });

  it("поза годинами: вт до 02:00 — ⏰, пт до 02:00 — OK", () => {
    const rows = [
      sheetRow({ date: TUE, b: 5, from: "22:00", to: "02:00" }),
      sheetRow({ date: FRI, b: 7, from: "22:00", to: "02:00" }),
    ];
    expect(status(rows, 0)).toBe("⏰ поза годинами роботи");
    expect(status(rows, 1)).toBe("✓ OK");
  });

  it("незаповнений рядок", () => {
    const rows = [["", 5, "", "", "", "Ім'я"]];
    expect(status(rows, 0)).toBe("⚠ заповніть дату, ПК і час");
  });
});

it("ID броні унікальний і короткий", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newBookingId(1_763_500_000_000)));
  expect(ids.size).toBeGreaterThan(195);
  expect([...ids][0]).toMatch(/^R-[0-9a-z]+-[0-9a-f]{6}$/);
});

describe("клієнтський підбір слотів і суміжних ПК", () => {
  const ZONES: Record<number, string> = Object.fromEntries(
    PC_LIST.map((pc) => [pc, pc === 18 || pc === 19 ? "Stream" : "Regular"]),
  );
  const REGULAR_PCS = zonePCs(PC_LIST, ZONES, "Regular"); // 1..17, 20..29
  const STREAM_PCS = zonePCs(PC_LIST, ZONES, "Stream"); // 18..19
  const SAT = FRI + 1;
  const SUN = FRI + 2;

  it("availableZones і zonePCs виділяють зони в порядку аркуша", () => {
    expect(availableZones(PC_LIST, ZONES)).toEqual(["Regular", "Stream"]);
    expect(STREAM_PCS).toEqual([18, 19]);
    expect(REGULAR_PCS).toHaveLength(27);
    expect(REGULAR_PCS).not.toContain(18);
  });

  it("intervalToBookingTime точно відновлюється через bookingInterval", () => {
    const cases: [number, number][] = [
      [TUE * 1440 + 18 * H, TUE * 1440 + 20 * H], // денний
      [TUE * 1440 + 22 * H, (TUE + 1) * 1440], // до 00:00
      [FRI * 1440 + 22 * H, (FRI + 1) * 1440 + 2 * H], // через північ
      [(FRI + 1) * 1440 + 1 * H, (FRI + 1) * 1440 + 4 * H], // після півночі
      [FRI * 1440 + 12 * H, (FRI + 1) * 1440 + 12 * H], // 24 год
    ];
    for (const [start, end] of cases) {
      const { date, from, to } = intervalToBookingTime(start, end);
      expect(bookingInterval(date, from, to)).toEqual({ start, end });
    }
  });

  it("allocateContiguousPCs: best-fit, не перестрибує через Stream, впритул — вільно", () => {
    const start = TUE * 1440 + 18 * H;
    const end = TUE * 1440 + 20 * H;
    const existing = parseBookingRows([
      sheetRow({ date: TUE, b: 1, c: 2, from: "18:00", to: "20:00" }), // 1-2 зайняті -> блок 3..17 (15 ПК)
      sheetRow({ date: TUE, b: 20, c: 25, from: "18:00", to: "20:00" }), // 20-25 зайняті -> блок 26..29 (4 ПК)
      sheetRow({ date: TUE, b: 26, c: 29, from: "16:00", to: "18:00" }), // впритул до 18:00 — НЕ заважає!
    ]);
    // 3 ПК — обирає блок 26..29 (розмір 4 < 15), не дробить великий блок 3..17.
    expect(allocateContiguousPCs({ zonePcs: REGULAR_PCS, count: 3, start, end, bookings: existing })).toEqual([26, 27, 28]);

    // 17 і 20 не є суміжними, бо 18–19 — Stream.
    const splitTest = parseBookingRows([
      sheetRow({ date: TUE, b: 1, c: 15, from: "18:00", to: "20:00" }), // вільні 16, 17 і 20..29
      sheetRow({ date: TUE, b: 22, c: 29, from: "18:00", to: "20:00" }), // вільні 16, 17 і 20, 21 (два блоки по 2!)
    ]);
    expect(allocateContiguousPCs({ zonePcs: REGULAR_PCS, count: 3, start, end, bookings: splitTest, strictContiguous: true })).toBeNull();
    // Без strictContiguous — мінімальний розмах (16, 17, 20: span 4 vs 17, 20, 21: span 4 -> менший старт 16)
    expect(allocateContiguousPCs({ zonePcs: REGULAR_PCS, count: 3, start, end, bookings: splitTest })).toEqual([16, 17, 20]);

    // preferredPcs
    expect(allocateContiguousPCs({ zonePcs: REGULAR_PCS, count: 2, start, end, bookings: existing, preferredPcs: [5, 7] })).toEqual([5, 7]);
    expect(allocateContiguousPCs({ zonePcs: REGULAR_PCS, count: 2, start, end, bookings: existing, preferredPcs: [2, 3] })).toBeNull();
  });

  it("findAvailableStartTimes: денна/нічна зміна, приховування минулого, вихідний, цілодобово", () => {
    // Вівторок 12:00–00:00; зараз вт 18:30 -> доступні 19:00..23:00 (24:00 уже зачинено, мін. 1 год)
    const tueNow = TUE * 1440 + 18 * H + 30;
    const tueSlots = findAvailableStartTimes({
      daySerial: TUE,
      schedule,
      zonePcs: STREAM_PCS,
      count: 1,
      bookings: [],
      nowAbs: tueNow,
    });
    expect(tueSlots.map((t) => t - TUE * 1440)).toEqual([19 * H, 20 * H, 21 * H, 22 * H, 23 * H]);

    // П'ятниця 12:00–06:00 (наступного дня); перевіряємо нічні слоти з 23:00 пт по 05:00 сб
    const friSlots = findAvailableStartTimes({
      daySerial: FRI,
      schedule,
      zonePcs: STREAM_PCS,
      count: 2,
      bookings: parseBookingRows([
        sheetRow({ date: SAT, b: 18, from: "01:00", to: "03:00" }), // 18 зайнятий 01:00–03:00
        sheetRow({ date: FRI, b: 19, from: "23:00", to: "01:00" }), // впритул до 01:00!
      ]),
      nowAbs: FRI * 1440 + 22 * H,
    });
    // 22:00 — вільно (22..23); 23:00 — 19 зайнятий; 00:00 — 19 зайнятий; 01:00, 02:00 — 18 зайнятий; 03:00, 04:00, 05:00 — вільні!
    expect(friSlots.map((t) => t - FRI * 1440)).toEqual([22 * H, 27 * H, 28 * H, 29 * H]);

    // Вихідний день
    const offSched = schedule.map((d, i) => (i === 1 ? { mode: "Вихідний", start: 0, end: 0 } : d));
    expect(
      findAvailableStartTimes({ daySerial: TUE, schedule: offSched, zonePcs: STREAM_PCS, count: 1, bookings: [], nowAbs: TUE * 1440 }),
    ).toEqual([]);

    // Цілодобовий день і крок 30 хв, на межі доби
    const allDaySched = schedule.map((d) => ({ mode: "Цілодобово", start: 0, end: 1440 }));
    const halfHourSlots = findAvailableStartTimes({
      daySerial: SUN,
      schedule: allDaySched,
      zonePcs: [1],
      count: 1,
      bookings: [],
      nowAbs: SUN * 1440 + 23 * H,
      stepMinutes: 30,
    });
    expect(halfHourSlots.map((t) => t - SUN * 1440)).toEqual([23 * H, 23 * H + 30]);
  });

  it("findAvailableDurations: обмеження закриттям, наступною бронню і «До закриття»", () => {
    // Вівторок, старт 21:00, закриття 00:00 (через 3 год) -> 1, 2, 3 год (3 год = до закриття)
    const d1 = findAvailableDurations({
      startAbs: TUE * 1440 + 21 * H,
      schedule,
      zonePcs: STREAM_PCS,
      count: 1,
      bookings: [],
    });
    expect(d1.map((x) => ({ m: x.minutes, close: x.toClose }))).toEqual([
      { m: 60, close: false },
      { m: 120, close: false },
      { m: 180, close: true },
    ]);

    // Старт 21:30, закриття 00:00 (2 год 30 хв) -> 1 год, 2 год, До закриття (150 хв)
    const dHalf = findAvailableDurations({
      startAbs: TUE * 1440 + 21 * H + 30,
      schedule,
      zonePcs: STREAM_PCS,
      count: 1,
      bookings: [],
    });
    expect(dHalf.map((x) => ({ m: x.minutes, close: x.toClose }))).toEqual([
      { m: 60, close: false },
      { m: 120, close: false },
      { m: 150, close: true },
    ]);

    // П'ятниця, старт 22:00, закриття 06:00 (8 год) -> 1..5 год + До закриття (480 хв)
    // ПК 18 зайнятий з 00:00, ПК 19 зайнятий з 01:00 (якщо 1 ПК: спочатку може дати 18, а на 3 год перемкнеться на 19!)
    const bookings = parseBookingRows([
      sheetRow({ date: SAT, b: 18, from: "00:00", to: "02:00" }),
      sheetRow({ date: SAT, b: 19, from: "01:00", to: "02:00" }),
    ]);
    const dNight = findAvailableDurations({
      startAbs: FRI * 1440 + 22 * H,
      schedule,
      zonePcs: STREAM_PCS,
      count: 1,
      bookings,
    });
    expect(dNight.map((x) => ({ m: x.minutes, pcs: x.pcs }))).toEqual([
      { m: 60, pcs: [18] },
      { m: 120, pcs: [18] },
      { m: 180, pcs: [19] },
    ]);

    // Якщо ж фіксовано preferredPcs: [18] -> максимум 2 год
    const dFixed = findAvailableDurations({
      startAbs: FRI * 1440 + 22 * H,
      schedule,
      zonePcs: STREAM_PCS,
      count: 1,
      bookings,
      preferredPcs: [18],
    });
    expect(dFixed.map((x) => x.minutes)).toEqual([60, 120]);

    // Якщо немає броней і старт о 22:00 пт -> 1..5 год + до закриття (8 год)
    const dFreeNight = findAvailableDurations({
      startAbs: FRI * 1440 + 22 * H,
      schedule,
      zonePcs: STREAM_PCS,
      count: 1,
      bookings: [],
    });
    expect(dFreeNight.map((x) => ({ m: x.minutes, close: x.toClose }))).toEqual([
      { m: 60, close: false },
      { m: 120, close: false },
      { m: 180, close: false },
      { m: 240, close: false },
      { m: 300, close: false },
      { m: 480, close: true },
    ]);
  });

  it("toPublicBusySlots і findPublicSlotSummaries фізично не містять PII", () => {
    const raw = parseBookingRows([
      sheetRow({ date: FRI, b: 18, c: 19, from: "19:00", to: "21:00", name: "Секретний Гість", contact: "+48 500 600 700", id: "R-sec" }),
    ]);
    const busy = toPublicBusySlots(raw, PC_LIST, ZONES);
    expect(busy).toEqual([
      { date: FRI, start: FRI * 1440 + 19 * H, end: FRI * 1440 + 21 * H, zone: "Stream", pcs: [18, 19], status: "busy" },
    ]);
    const serialized = JSON.stringify(busy);
    expect(serialized).not.toContain("Секретний");
    expect(serialized).not.toContain("500 600");
    expect(serialized).not.toContain("R-sec");

    const summary = findPublicSlotSummaries({
      daySerial: FRI,
      schedule,
      zone: "Stream",
      zonePcs: STREAM_PCS,
      count: 1,
      busySlots: busy,
      nowAbs: FRI * 1440 + 18 * H,
    });
    const slot19 = summary.find((s) => s.start === FRI * 1440 + 19 * H)!;
    expect(slot19).toMatchObject({ zone: "Stream", status: "busy", freeCount: 0, pcs: [] });
    const slot21 = summary.find((s) => s.start === FRI * 1440 + 21 * H)!;
    expect(slot21).toMatchObject({ zone: "Stream", status: "free", freeCount: 2, pcs: [18, 19] });

    // Підбір тривалості також працює напряму поверх PublicSlotSummary[]
    const durs = findAvailableDurations({
      startAbs: FRI * 1440 + 18 * H,
      schedule,
      zonePcs: STREAM_PCS,
      count: 1,
      bookings: busy,
    });
    expect(durs.map((d) => d.minutes)).toEqual([60]);
  });
});
