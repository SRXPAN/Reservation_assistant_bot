import { describe, expect, it } from "vitest";
import { coveredUntil, isWithinHours, openWindowAt, parseSchedule, windowOf } from "../src/hours";
import { dateToSerial } from "../src/time";
import { CLUB_HOURS_ROWS } from "./helpers";

const H = 60;
const schedule = parseSchedule(CLUB_HOURS_ROWS);
// Тиждень 23–29.11.2026: пн 23, вт 24, ср 25, чт 26, пт 27, сб 28, нд 29.
const MON = dateToSerial(2026, 11, 23);
const TUE = MON + 1;
const THU = MON + 3;
const FRI = MON + 4;
const SAT = MON + 5;
const SUN = MON + 6;
const at = (day: number, minutes: number) => day * 1440 + minutes;

describe("розбір годин роботи", () => {
  it("закриття ≤ відкриття → наступного дня (як Sched_S/Sched_E)", () => {
    expect(schedule[0]).toEqual({ mode: "Години", start: 12 * H, end: 24 * H }); // пн 12:00–00:00
    expect(schedule[3]).toEqual({ mode: "Години", start: 12 * H, end: 30 * H }); // чт 12:00–06:00
    expect(schedule[6]).toEqual({ mode: "Години", start: 10 * H, end: 24 * H }); // нд 10:00–00:00
  });

  it("Цілодобово, Вихідний, порожні клітинки, текстовий час", () => {
    const s = parseSchedule([
      ["Пн", "Цілодобово", "", ""],
      ["Вт", "Вихідний", 0.5, 0.25],
      ["Ср", "Години", "", 0.25],
      ["Чт", "Години", "12:00", "02:00"],
      ["Пт", "щось інше", 0.5, 0.9],
      ["Сб", "Години", 0.5, 0.5],
    ]);
    expect(s[0]).toMatchObject({ start: 0, end: 24 * H });
    expect(s[1]).toMatchObject({ start: 0, end: 0 });
    expect(s[2]).toMatchObject({ start: 0, end: 0 });
    expect(s[3]).toMatchObject({ start: 12 * H, end: 26 * H });
    expect(s[4]).toMatchObject({ start: 0, end: 0 });
    expect(s[5]).toMatchObject({ start: 12 * H, end: 36 * H }); // відкриття = закриття → 24 години
    expect(s[6]).toMatchObject({ start: 0, end: 0 }); // рядка немає
  });

  it("вікно дня в абсолютних хвилинах", () => {
    expect(windowOf(schedule, THU)).toEqual({ start: at(THU, 12 * H), end: at(FRI, 6 * H) });
  });
});

describe("бронь у робочих годинах", () => {
  it("звичайна денна бронь", () => {
    expect(isWithinHours(schedule, TUE, at(TUE, 18 * H), at(TUE, 20 * H))).toBe(true);
    expect(isWithinHours(schedule, TUE, at(TUE, 11 * H), at(TUE, 13 * H))).toBe(false); // відкриття о 12
  });

  it("нічна бронь до 02:00: у пт можна, у вт (закриття 00:00) — ні", () => {
    expect(isWithinHours(schedule, FRI, at(FRI, 22 * H), at(SAT, 2 * H))).toBe(true);
    expect(isWithinHours(schedule, TUE, at(TUE, 22 * H), at(TUE + 1, 2 * H))).toBe(false);
    // До 00:00 у вівторок — рівно до закриття.
    expect(isWithinHours(schedule, TUE, at(TUE, 22 * H), at(TUE + 1, 0))).toBe(true);
  });

  it("01:00 у пятницю — це ще вікно четверга 12:00–06:00", () => {
    expect(isWithinHours(schedule, FRI, at(FRI, 1 * H), at(FRI, 3 * H))).toBe(true);
    expect(isWithinHours(schedule, FRI, at(FRI, 5 * H), at(FRI, 7 * H))).toBe(false); // після 06:00 зачинено
    expect(coveredUntil(schedule, FRI, at(FRI, 1 * H))).toBe(at(FRI, 6 * H));
    // А 01:00 у середу — вікно вівторка закрилося о 00:00.
    expect(isWithinHours(schedule, TUE + 1, at(TUE + 1, 1 * H), at(TUE + 1, 2 * H))).toBe(false);
  });

  it("межа доби: нд 10:00–00:00, бронь пн 00:00 — поза годинами", () => {
    expect(isWithinHours(schedule, SUN, at(SUN, 22 * H), at(SUN + 1, 0))).toBe(true);
    expect(isWithinHours(schedule, MON + 7, at(MON + 7, 0), at(MON + 7, 1 * H))).toBe(false);
  });

  it("ланцюжок вікон: нд до 00:00, а пн цілодобово — бронь через північ проходить", () => {
    const s = parseSchedule([["Пн", "Цілодобово"], ...CLUB_HOURS_ROWS.slice(1)]);
    expect(isWithinHours(s, SUN, at(SUN, 22 * H), at(SUN + 1, 3 * H))).toBe(true);
    // Пн цілодобово (00–24) → вт 12:00: о 00:00–12:00 вівторка зачинено.
    expect(isWithinHours(s, MON, at(MON, 20 * H), at(TUE, 2 * H))).toBe(false);
  });

  it("вихідний день: бронь удень — ні, але ніч попереднього дня ще працює", () => {
    const rows = CLUB_HOURS_ROWS.map((r) => [...r]);
    rows[4] = ["П'ятниця", "Вихідний", 0.5, 0.25];
    const s = parseSchedule(rows);
    expect(isWithinHours(s, FRI, at(FRI, 14 * H), at(FRI, 16 * H))).toBe(false);
    expect(isWithinHours(s, FRI, at(FRI, 1 * H), at(FRI, 5 * H))).toBe(true); // вікно четверга до 06:00
    expect(isWithinHours(s, THU, at(THU, 22 * H), at(FRI, 6 * H))).toBe(true);
  });

  it("яке вікно відкрите зараз", () => {
    expect(openWindowAt(schedule, at(FRI, 1 * H))).toMatchObject({ day: THU });
    expect(openWindowAt(schedule, at(FRI, 13 * H))).toMatchObject({ day: FRI });
    expect(openWindowAt(schedule, at(FRI, 8 * H))).toBeNull();
  });
});
