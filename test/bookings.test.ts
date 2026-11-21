import { describe, expect, it } from "vitest";
import {
  bookingInterval,
  complete,
  expectedStatus,
  findConflicts,
  freeRows,
  isOkStatus,
  newBookingId,
  parseBookingRows,
  rowValues,
  splitIntoRuns,
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
