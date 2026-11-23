import { describe, expect, it } from "vitest";
import { parseBookingRows } from "../src/bookings";
import { parseSchedule } from "../src/hours";
import {
  clientReminderKey,
  clientReminderText,
  planClientReminders,
  planNotifications,
  reminderKey,
  reminderText,
  summaryKey,
  summaryTime,
  withAttendance,
  withClientConfirm,
  type Action,
} from "../src/notify";
import { dateToSerial } from "../src/time";
import { toEntries } from "../src/views";
import { CLUB_HOURS_ROWS, PC_LIST, sheetRow } from "./helpers";

const schedule = parseSchedule(CLUB_HOURS_ROWS); // пн–ср 12–00, чт–сб 12–06, нд 10–00
const THU = dateToSerial(2026, 11, 19);
const FRI = THU + 1;
const SAT = THU + 2;
const at = (day: number, h: number, m = 0) => day * 1440 + h * 60 + m;

const entries = toEntries(
  parseBookingRows([
    sheetRow({ date: FRI, b: 12, c: 17, from: "19:00", to: "02:00", name: "Vova", contact: "tg", id: "R-vova" }),
    sheetRow({ date: FRI, b: 18, from: "16:00", to: "19:00", name: "Андрій", contact: "+48 501 234 567" }), // ручна, без ID
    sheetRow({ date: SAT, b: 7, from: "01:00", to: "03:00", name: "Нічний", id: "R-night" }),
    // Несуміжні ПК — два рядки, одна бронь.
    sheetRow({ date: FRI, b: 1, from: "20:00", to: "21:00", name: "Ян", id: "R-yan" }),
    sheetRow({ date: FRI, b: 3, from: "20:00", to: "21:00", name: "Ян", id: "R-yan" }),
  ]),
  PC_LIST,
);
const vova = entries.find((e) => e.id === "R-vova")!;
const andriy = entries.find((e) => e.name === "Андрій")!;

/** План без зведень — щоб дивитися лише на нагадування. */
function reminders(now: number, sent: string[] = []) {
  return planNotifications({ entries, schedule, firstHour: 720, now, sent: new Set([...sent, summaryKey(THU), summaryKey(FRI), summaryKey(SAT)]) }).filter(
    (a): a is Extract<Action, { kind: "reminder" }> => a.kind === "reminder",
  );
}
const names = (list: { entry: { name: string } }[]) => list.map((a) => a.entry.name);

describe("нагадування за 30 хв", () => {
  it("рано — нічого; рівно за 30 хв — нагадування", () => {
    expect(names(reminders(at(FRI, 18, 25)))).toEqual(["Андрій"]); // Андрій з 16:00 — уже йде (див. нижче)
    expect(reminders(at(FRI, 18, 25)).find((a) => a.entry === vova)).toBeUndefined();
    const r = reminders(at(FRI, 18, 30)).find((a) => a.entry === vova)!;
    expect(r).toMatchObject({ key: "r:R-vova:" + vova.start, minutesLeft: 30, started: false });
  });

  it("Cron трохи запізнився — «через 27 хв»", () => {
    expect(reminders(at(FRI, 18, 33)).find((a) => a.entry === vova)).toMatchObject({ minutesLeft: 27 });
  });

  it("без дублів: ключ уже є — не шлемо", () => {
    expect(reminders(at(FRI, 18, 35), [reminderKey(vova)]).find((a) => a.entry === vova)).toBeUndefined();
  });

  it("бронь записали за 10 хв до початку — нагадування одразу, «через 10 хв»", () => {
    expect(reminders(at(FRI, 19, 50)).find((a) => a.entry.name === "Ян")).toMatchObject({ minutesLeft: 10, started: false });
  });

  it("після простою: бронь уже почалась, але не закінчилась — «уже почалось»; закінчилась — нічого", () => {
    expect(reminders(at(FRI, 17))).toEqual([expect.objectContaining({ started: true, minutesLeft: 0, entry: andriy })]);
    expect(reminders(at(FRI, 19, 0)).map((a) => a.entry.name)).toEqual(["Vova"]); // Андрій до 19:00 — уже скінчився
  });

  it("нічна бронь 01:00 у суботу — нагадування о 00:30", () => {
    expect(names(reminders(at(SAT, 0, 30)))).toEqual(["Vova", "Нічний"]); // Vova триває до 02:00
    expect(reminders(at(SAT, 0, 30)).find((a) => a.entry.name === "Нічний")).toMatchObject({ minutesLeft: 30 });
  });

  it("несуміжні ПК однієї броні — одне нагадування", () => {
    const list = reminders(at(FRI, 19, 30)).filter((a) => a.entry.name === "Ян");
    expect(list).toHaveLength(1);
    expect(list[0]!.entry.pcs).toEqual([1, 3]);
  });

  it("ручна бронь — ключ із дати/часу/ПК/імені; змінили час — новий ключ", () => {
    expect(reminderKey(andriy)).toBe(`r:m:${andriy.start}:18-18:Андрій`);
    expect(reminderKey({ ...vova, start: vova.start + 60 })).not.toBe(reminderKey(vova));
  });

  it("текст нагадування", () => {
    const r = reminders(at(FRI, 18, 30)).find((a) => a.entry === vova)!;
    expect(reminderText(r, PC_LIST)).toBe("⏰ Через 30 хв (19:00–02:00): ПК 12–17 (6 ПК) — Vova (tg)");
    const late = reminders(at(FRI, 17)).find((a) => a.entry === andriy)!;
    expect(reminderText(late, PC_LIST)).toBe("⏰ Уже почалось (16:00–19:00): ПК 18 — Андрій (+48 501 234 567)");
  });
});

describe("щоденне зведення в годину відкриття", () => {
  const summaries = (now: number, sent: string[] = [], sched = schedule, firstHour = 720) =>
    planNotifications({ entries: [], schedule: sched, firstHour, now, sent: new Set(sent) }).filter((a) => a.kind === "summary");

  it("до відкриття — нічого; о 12:00 — зведення п'ятниці", () => {
    expect(summaries(at(FRI, 11, 55))).toEqual([]);
    expect(summaries(at(FRI, 12, 0))).toEqual([{ kind: "summary", key: `s:${FRI}`, day: FRI, at: at(FRI, 12), late: false }]);
    expect(summaries(at(FRI, 12, 5), [`s:${FRI}`])).toEqual([]);
  });

  it("наздоганяємо після простою: о 15:00 і навіть о 01:00 суботи (вікно п'ятниці ще триває) — «із запізненням»", () => {
    expect(summaries(at(FRI, 15))).toMatchObject([{ day: FRI, late: true }]);
    expect(summaries(at(SAT, 1))).toMatchObject([{ day: FRI, late: true }]);
    expect(summaries(at(SAT, 6))).toEqual([]); // п'ятниця закрилась о 06:00, субота ще не відкрилась
  });

  it("неділя відкривається о 10:00", () => {
    expect(summaries(at(SAT + 1, 10))).toMatchObject([{ day: SAT + 1, late: false }]);
  });

  it("цілодобово — о годині «розклад з» (C15); вихідний — без зведення", () => {
    const rows = CLUB_HOURS_ROWS.map((r) => [...r]);
    rows[4] = ["П'ятниця", "Цілодобово", "", ""];
    rows[5] = ["Субота", "Вихідний", 0.5, 0.25];
    const s = parseSchedule(rows);
    expect(summaryTime(s, 9 * 60, FRI)).toEqual({ at: at(FRI, 9), until: at(SAT, 0) });
    expect(summaryTime(s, 9 * 60, SAT)).toBeNull();
    expect(summaries(at(FRI, 9), [`s:${THU}`], s, 9 * 60)).toMatchObject([{ day: FRI }]);
    expect(summaries(at(SAT, 14), [`s:${FRI}`], s, 9 * 60)).toEqual([]);
  });
});

describe("відмітка в примітці", () => {
  it("дописується до тексту; повторна — замінює попередню", () => {
    expect(withAttendance("", true, "Сеня", "18:55")).toBe("✅ прийшов (Сеня 18:55)");
    const once = withAttendance("день народження", true, "Сеня", "18:55");
    expect(once).toBe("день народження · ✅ прийшов (Сеня 18:55)");
    expect(withAttendance(once, false, "Оля", "19:20")).toBe("день народження · ❌ не прийшов (Оля 19:20)");
  });
});

describe("клієнтські нагадування за 30 хв", () => {
  it("planClientReminders планує лише броні з clientOwners без дублів", () => {
    const owners = new Map<string, number>([["R-vova", 777]]);
    expect(planClientReminders({ entries, clientOwners: owners, now: at(FRI, 18, 25), sent: new Set() })).toEqual([]);
    const list = planClientReminders({ entries, clientOwners: owners, now: at(FRI, 18, 30), sent: new Set() });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "client_reminder", key: clientReminderKey(vova), clientTgId: 777, minutesLeft: 30, started: false });
    expect(clientReminderText(list[0]!, PC_LIST)).toBe(
      "⏰ Нагадуємо: ваша бронь ПК 12–17 (6 ПК) починається о 19:00 (через 30 хв). Все в силі?",
    );
    expect(planClientReminders({ entries, clientOwners: owners, now: at(FRI, 18, 35), sent: new Set([clientReminderKey(vova)]) })).toEqual([]);
  });

  it("withClientConfirm додає і замінює відмітку підтвердження в примітці", () => {
    const first = withClientConfirm("клієнт через бот", "18:35");
    expect(first).toBe("клієнт через бот · клієнт підтвердив (18:35)");
    expect(withClientConfirm(first, "18:40")).toBe("клієнт через бот · клієнт підтвердив (18:40)");
    expect(withClientConfirm("", "18:40")).toBe("клієнт підтвердив (18:40)");
  });
});
