import { describe, expect, it } from "vitest";
import {
  dateToSerial,
  formatDate,
  formatHHMM,
  fractionToMinutes,
  isValidDate,
  minutesToFraction,
  mondayOf,
  nowAbs,
  parseHHMM,
  serialToDate,
  weekdayIndex,
  zonedNow,
} from "../src/time";

describe("серійні дати таблиці", () => {
  it("збігаються з тим, що повертає таблиця", () => {
    // Рядок-приклад: 11.11.2026 → 46337; B3 =TODAY() 19.11.2026 → 46345; WeekMon 16.11.2026 → 46342.
    expect(dateToSerial(2026, 11, 11)).toBe(46337);
    expect(dateToSerial(2026, 11, 19)).toBe(46345);
    expect(dateToSerial(1899, 12, 30)).toBe(0);
    expect(dateToSerial(1900, 3, 1)).toBe(61);
  });

  it("працюють в обидва боки, зокрема через межу року і 29 лютого", () => {
    for (const [y, m, d] of [
      [2026, 12, 31],
      [2027, 1, 1],
      [2028, 2, 29],
      [2026, 3, 29],
    ] as const) {
      expect(serialToDate(dateToSerial(y, m, d))).toEqual({ y, m, d });
    }
    expect(serialToDate(46337.666666)).toEqual({ y: 2026, m: 11, d: 11 });
    expect(formatDate(46345)).toBe("19.11.2026");
  });

  it("перевіряють неіснуючі дати", () => {
    expect(isValidDate(2026, 2, 29)).toBe(false);
    expect(isValidDate(2028, 2, 29)).toBe(true);
    expect(isValidDate(2026, 11, 31)).toBe(false);
  });

  it("день тижня і понеділок тижня (як WEEKDAY і B3−WEEKDAY(B3;3))", () => {
    expect(weekdayIndex(46345)).toBe(3); // чт 19.11.2026
    expect(weekdayIndex(46342)).toBe(0); // пн 16.11.2026
    expect(weekdayIndex(46348)).toBe(6); // нд 22.11.2026
    expect(mondayOf(46345)).toBe(46342);
    expect(mondayOf(46348)).toBe(46342);
    expect(mondayOf(46349)).toBe(46349);
  });
});

describe("час як частка доби", () => {
  it("хвилини ↔ частка доби", () => {
    expect(minutesToFraction(16 * 60)).toBeCloseTo(0.6666666666, 9);
    expect(minutesToFraction(6 * 60)).toBe(0.25);
    expect(minutesToFraction(0)).toBe(0);
    // Таблиця повертає 0.666666666666667 — округлення до цілих хвилин.
    expect(fractionToMinutes(0.666666666666667)).toBe(960);
    expect(fractionToMinutes(0.791666666666667)).toBe(1140);
    expect(fractionToMinutes(0.416666666666667)).toBe(600);
    // Дата+час (46337.666…) → лише час, як MOD(x; 1).
    expect(fractionToMinutes(46337.666666666664)).toBe(960);
    expect(fractionToMinutes(0.99999999999)).toBe(0);
  });

  it("розбір і формат «HH:MM»", () => {
    expect(parseHHMM("19:00")).toBe(1140);
    expect(parseHHMM("9:30")).toBe(570);
    expect(parseHHMM("02.00")).toBe(120);
    expect(parseHHMM("24:00")).toBe(1440);
    expect(parseHHMM("24:30")).toBeNull();
    expect(parseHHMM("19:60")).toBeNull();
    expect(parseHHMM("19")).toBeNull();
    expect(formatHHMM(1140)).toBe("19:00");
    expect(formatHHMM(1440 + 120)).toBe("02:00");
    expect(formatHHMM(1440)).toBe("00:00");
  });
});

describe("поточний час клубу (Europe/Warsaw)", () => {
  const tz = "Europe/Warsaw";

  it("зимовий час: UTC+1", () => {
    expect(zonedNow(tz, new Date("2026-11-19T22:30:00Z"))).toEqual({ serial: 46345, minutes: 23 * 60 + 30 });
    // Після півночі за Варшавою — уже наступна дата.
    expect(zonedNow(tz, new Date("2026-11-19T23:30:00Z"))).toEqual({ serial: 46346, minutes: 30 });
  });

  it("переходи на літній і зимовий час", () => {
    // 29.03.2026 о 01:00 UTC годинник переводять з 02:00 на 03:00.
    expect(zonedNow(tz, new Date("2026-03-29T00:30:00Z")).minutes).toBe(90);
    expect(zonedNow(tz, new Date("2026-03-29T01:30:00Z")).minutes).toBe(3 * 60 + 30);
    // 25.10.2026 о 01:00 UTC — з 03:00 назад на 02:00.
    expect(zonedNow(tz, new Date("2026-10-25T00:30:00Z")).minutes).toBe(2 * 60 + 30);
    expect(zonedNow(tz, new Date("2026-10-25T01:30:00Z")).minutes).toBe(2 * 60 + 30);
  });

  it("абсолютна хвилина = серійна дата × 1440 + хвилини", () => {
    expect(nowAbs(tz, new Date("2026-11-19T17:00:00Z"))).toBe(46345 * 1440 + 18 * 60);
  });
});
