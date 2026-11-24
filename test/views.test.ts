import { describe, expect, it } from "vitest";
import { parseBookingRows, toPublicBusySlots } from "../src/bookings";
import { parseSchedule } from "../src/hours";
import { dateToSerial } from "../src/time";
import { businessDay, countLabel, dayView, freeNowView, publicAvailabilityView, searchView, statusMark, toEntries } from "../src/views";
import { CLUB_HOURS_ROWS, PC_LIST, sheetRow } from "./helpers";

const schedule = parseSchedule(CLUB_HOURS_ROWS);
const s = { pcList: PC_LIST, schedule };
const THU = dateToSerial(2026, 11, 19);
const FRI = THU + 1;
const SAT = THU + 2;
const at = (day: number, h: number, m = 0) => day * 1440 + h * 60 + m;

const rows = parseBookingRows([
  sheetRow({ date: FRI, b: 18, from: "16:00", to: "19:00", name: "Андрій", contact: "+48 501 234 567", status: "✓ OK" }),
  sheetRow({ date: FRI, b: 12, c: 17, from: "18:00", to: "22:00", name: "Дмитро", contact: "tg", status: "✓ OK · група 6 ПК" }),
  sheetRow({ date: FRI, b: 14, from: "21:00", to: "23:00", name: "Ліза", status: "⚠ НАКЛАДКА: ПК вже зайнятий" }),
  // Нічна частина п'ятниці (01:00 сб) — належить робочому дню п'ятниці.
  sheetRow({ date: SAT, b: 7, from: "01:00", to: "03:00", name: "Нічний", status: "✓ OK" }),
  // Несуміжні ПК однієї броні — два рядки з одним ID.
  sheetRow({ date: SAT, b: 1, from: "15:00", to: "17:00", name: "Ян", contact: "insta", status: "✓ OK", id: "R-yan" }),
  sheetRow({ date: SAT, b: 3, from: "15:00", to: "17:00", name: "Ян", contact: "insta", status: "✓ OK", id: "R-yan" }),
  sheetRow({ date: SAT, b: 9, from: "10:00", to: "12:00", name: "Ранній", status: "⏰ поза годинами роботи" }),
  // Минула бронь Андрія.
  sheetRow({ date: THU - 7, b: 2, from: "14:00", to: "15:00", name: "Андрій", contact: "+48 501 234 567", status: "✓ інший тиждень" }),
]);
const entries = toEntries(rows, PC_LIST);

describe("броні для показу", () => {
  it("рядки з одним ID злиті; ручні — окремо; за часом", () => {
    const yan = entries.find((e) => e.id === "R-yan")!;
    expect(yan).toMatchObject({ pcs: [1, 3], rows: [14, 15] });
    expect(entries.map((e) => e.name)).toEqual(["Андрій", "Андрій", "Дмитро", "Ліза", "Нічний", "Ранній", "Ян"]);
  });

  it("робочий день: 01:00 суботи — ще п'ятниця; 10:00 суботи (зачинено) — субота", () => {
    expect(businessDay(schedule, at(SAT, 1))).toBe(FRI);
    expect(businessDay(schedule, at(SAT, 10))).toBe(SAT);
    expect(businessDay(schedule, at(FRI, 18))).toBe(FRI);
  });

  it("позначки статусу", () => {
    expect(statusMark(["✓ OK"])).toBe("");
    expect(statusMark(["✓ OK", "⚠ НАКЛАДКА: ПК з групи зайнятий"])).toBe(" ⚠ накладка");
    expect(statusMark(["⏰ поза годинами роботи"])).toBe(" ⏰ поза годинами");
    expect(countLabel(1)).toBe("1 бронювання");
    expect(countLabel(3)).toBe("3 бронювання");
    expect(countLabel(5)).toBe("5 бронювань");
    expect(countLabel(11)).toBe("11 бронювань");
    expect(countLabel(22)).toBe("22 бронювання");
  });
});

describe("Сьогодні / Завтра", () => {
  it("п'ятниця: за часом, з нічною бронню і позначкою накладки", () => {
    expect(dayView(entries, s, FRI, "Сьогодні")).toBe(
      [
        "📅 <b>Сьогодні · пт 20.11</b> (12:00–06:00) — 4 бронювання",
        "",
        "16:00–19:00 · ПК 18 · Андрій · +48 501 234 567",
        "18:00–22:00 · ПК 12–17 (6 ПК) · Дмитро · tg",
        "21:00–23:00 · ПК 14 · Ліза ⚠ накладка",
        "01:00–03:00 · ПК 7 · Нічний",
      ].join("\n"),
    );
  });

  it("субота: несуміжні ПК одним рядком, ⏰", () => {
    expect(dayView(entries, s, SAT, "Завтра")).toBe(
      [
        "📅 <b>Завтра · сб 21.11</b> (12:00–06:00) — 2 бронювання",
        "",
        "10:00–12:00 · ПК 9 · Ранній ⏰ поза годинами",
        "15:00–17:00 · ПК 1, 3 (2 ПК) · Ян · insta",
      ].join("\n"),
    );
  });

  it("порожній день", () => {
    expect(dayView(entries, s, SAT + 1, "Завтра")).toContain("Бронювань немає.");
  });
});

describe("Вільні зараз", () => {
  it("пт 18:30: хто зайнятий і до котрої, хто вільний і до котрої", () => {
    const text = freeNowView(entries, s, at(FRI, 18, 30));
    expect(text).toContain("🟢 <b>Вільні зараз</b> · пт 20.11 18:30");
    expect(text).toContain("• ПК 1–6, 8–11, 19–29 — до закриття (06:00)");
    expect(text).toContain("• ПК 7 — до 01:00 (далі Нічний)");
    expect(text).toContain("🔴 <b>Зайняті</b>");
    expect(text).toContain("• ПК 12–13, 15–17 — до 22:00 · Дмитро");
    // ПК 14: Дмитро до 22:00, а Ліза — з 21:00 (накладка) → зайнятий до 23:00.
    expect(text).toContain("• ПК 14 — до 23:00 · Дмитро, Ліза");
    expect(text).toContain("• ПК 18 — до 19:00 · Андрій");
  });

  it("нічна бронь через північ: «(наст. дня)»", () => {
    const text = freeNowView(entries, s, at(SAT, 2));
    expect(text).toContain("• ПК 7 — до 03:00 · Нічний");
    const late = freeNowView(toEntries(parseBookingRows([sheetRow({ date: FRI, b: 5, from: "22:00", to: "02:00", name: "Макс" })]), PC_LIST), s, at(FRI, 23));
    expect(late).toContain("• ПК 5 — до 02:00 (наст. дня) · Макс");
  });

  it("клуб зачинений", () => {
    expect(freeNowView(entries, s, at(SAT, 8))).toBe("🔒 Клуб зараз зачинений. Відкриття: сб 21.11 о 12:00.");
  });
});

describe("Пошук", () => {
  const now = at(FRI, 12);
  it("за ім'ям без урахування регістру: майбутні й минулі окремо", () => {
    const text = searchView(entries, s, "андрій", now);
    expect(text).toContain("Майбутні:\nпт 20.11 16:00–19:00 · ПК 18 · Андрій");
    expect(text).toContain("Минулі (останні):\nчт 12.11 14:00–15:00 · ПК 2 · Андрій");
  });
  it("за частиною телефону (цифри без пробілів)", () => {
    expect(searchView(entries, s, "501234", now)).toContain("Андрій");
    expect(searchView(entries, s, "insta", now)).toContain("ПК 1, 3 (2 ПК) · Ян");
  });
  it("нічого не знайдено; HTML екранується", () => {
    expect(searchView(entries, s, "<Петро>", now)).toBe("🔎 <b>Пошук «&lt;Петро&gt;»</b>\n\nНічого не знайдено.");
  });
});

describe("Публічна доступність без PII", () => {
  const zones = Object.fromEntries(PC_LIST.map((pc) => [pc, pc === 18 || pc === 19 ? "Stream" : "Regular"]));

  it("publicAvailabilityView показує лише кількість вільних ПК по зонах і не містить жодних імен/телефонів", () => {
    const busy = toPublicBusySlots(rows, PC_LIST, zones);
    const text = publicAvailabilityView(busy, { ...s, zones }, at(FRI, 18, 30));
    expect(text).toContain("🟢 <b>Вільні місця зараз</b> · пт 20.11 18:30");
    expect(text).toContain("<b>Regular:</b> вільно 21 з 27 ПК");
    expect(text).toContain("<b>Stream:</b> вільно 1 з 2 ПК");
    for (const pii of ["Андрій", "Дмитро", "Ліза", "Нічний", "501", "234", "tg", "insta"]) {
      expect(text).not.toContain(pii);
    }
  });

  it("коли клуб зачинений — лише час відкриття", () => {
    const busy = toPublicBusySlots(rows, PC_LIST, zones);
    expect(publicAvailabilityView(busy, { ...s, zones }, at(SAT, 8))).toBe("🔒 Клуб зараз зачинений. Відкриття: сб 21.11 о 12:00.");
  });
});
