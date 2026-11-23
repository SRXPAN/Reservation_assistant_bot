import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { mergeAi, validateAiAnswer } from "../src/ai";
import { checkBlock, durationLabel, fieldsBlock, pcsLabel } from "../src/card";
import { evaluate } from "../src/check";
import { parseSchedule } from "../src/hours";
import { emptyDraft } from "../src/parse";
import { parseBookingRows } from "../src/bookings";
import { dateToSerial } from "../src/time";
import { CLUB_HOURS_ROWS, PC_LIST, fakeD1, sheetRow } from "./helpers";

const TODAY = dateToSerial(2026, 11, 19);
const FRI = TODAY + 1;
const schedule = parseSchedule(CLUB_HOURS_ROWS);
const settings = { pcList: PC_LIST, zones: { 18: "Stream", 12: "Regular" } as Record<number, string>, schedule };

describe("відповідь Workers AI перевіряється за схемою", () => {
  it("коректна відповідь (рядком або об'єктом)", () => {
    const ok = { date: "2026-11-20", pcs: [12, 13], from: "19:00", to: "02:00", name: "Vova", contact: "tg", note: null };
    expect(validateAiAnswer(JSON.stringify(ok), TODAY, PC_LIST)).toEqual({ date: FRI, pcs: [12, 13], from: 1140, to: 120, name: "Vova", contact: "tg" });
    expect(validateAiAnswer(ok, TODAY, PC_LIST)).toMatchObject({ pcs: [12, 13] });
  });
  it("відкидає вигадане й зіпсоване", () => {
    expect(validateAiAnswer("не json", TODAY, PC_LIST)).toBeNull();
    expect(validateAiAnswer([1, 2], TODAY, PC_LIST)).toBeNull();
    const bad = validateAiAnswer({ date: "2026-02-30", pcs: [12, 99], from: "25:00", to: "7pm", name: "", contact: 5 }, TODAY, PC_LIST);
    expect(bad).toBeNull();
    expect(validateAiAnswer({ date: "2030-01-01", pcs: [] }, TODAY, PC_LIST)).toBeNull(); // занадто далеко
  });
  it("заповнює лише порожні поля", () => {
    const d = { ...emptyDraft(), date: FRI, name: "Олег" };
    const { draft, used } = mergeAi(d, { date: FRI + 5, pcs: [3], name: "Інший" });
    expect(used).toBe(true);
    expect(draft).toMatchObject({ date: FRI, pcs: [3], name: "Олег" });
    expect(draft.hints.at(-1)).toMatch(/ШІ/);
  });
});

describe("текст картки", () => {
  it("ПК: діапазон, несуміжні, змішані", () => {
    expect(pcsLabel([12, 13, 14, 15, 16, 17], PC_LIST)).toBe("ПК 12–17 (6 ПК)");
    expect(pcsLabel([12, 14, 16], PC_LIST)).toBe("ПК 12, 14, 16 (3 ПК)");
    expect(pcsLabel([1, 2, 3, 7], PC_LIST)).toBe("ПК 1–3, 7 (4 ПК)");
    expect(pcsLabel([18], PC_LIST)).toBe("ПК 18");
  });
  it("тривалість", () => {
    expect(durationLabel(420)).toBe("7 год");
    expect(durationLabel(150)).toBe("2 год 30 хв");
    expect(durationLabel(30)).toBe("30 хв");
  });
  it("як у SPEC.md: дата, ПК із зоною, нічний час «(до сб)», ім'я · контакт, примітка", () => {
    const d = { ...emptyDraft(), date: FRI, pcs: [12, 13, 14, 15, 16, 17], from: 1140, to: 120, name: "Vova", contact: "tg", note: "<день> народження" };
    expect(fieldsBlock(d, settings)).toEqual([
      "📅 Пт 20.11.2026",
      "💻 ПК 12–17 (6 ПК) · Regular",
      "🕒 19:00 – 02:00 (до сб) · 7 год",
      "👤 Vova · tg",
      "📝 &lt;день&gt; народження",
    ]);
  });
  it("накладка з групою, поза годинами, минуле, підказки", () => {
    const rows = parseBookingRows([sheetRow({ date: FRI, b: 12, c: 17, from: "18:00", to: "22:00", name: "Дмитро" })]);
    const d = { ...emptyDraft(), date: FRI, pcs: [14, 15], from: 600, to: 1200, name: "Ян", hints: ["перевірте дату"] };
    const c = evaluate(d, rows, schedule, (FRI + 1) * 1440);
    expect(checkBlock(d, c, settings)).toEqual([
      "⚠ <b>Накладка</b>",
      "ПК 14, 15 зайняті: Дмитро (група ПК 12–17) 18:00–22:00",
      "⏰ Поза годинами роботи (пт 12:00–06:00)",
      "🕓 Цей час уже минув",
      "ℹ️ перевірте дату",
    ]);
  });
});

describe("міграції", () => {
  it("застосовуються по порядку на чисту базу", () => {
    expect(readdirSync("migrations").sort()).toEqual([
      "0001_init.sql",
      "0002_cards.sql",
      "0003_prompts_generic.sql",
      "0004_reminders.sql",
      "0005_client_bookings.sql",
    ]);
    expect(() => fakeD1()).not.toThrow();
  });

  it("0003 зберігає наявні запити і дозволяє запит без картки", () => {
    const db = new DatabaseSync(":memory:");
    const apply = (f: string) => db.exec(`BEGIN;\n${readFileSync(`migrations/${f}`, "utf8")}\nCOMMIT;`);
    db.exec("PRAGMA foreign_keys = ON");
    apply("0001_init.sql");
    apply("0002_cards.sql");
    db.exec(`
      INSERT INTO cards (id, chat_id, state, data, created_by, created_by_name) VALUES ('R-1', -1, 'draft', '{}', 1, 'Сеня');
      INSERT INTO prompts (chat_id, message_id, card_id, field, user_id) VALUES (-1, 5, 'R-1', 'pcs', 1);
    `);
    apply("0003_prompts_generic.sql");
    expect(db.prepare("SELECT card_id, field FROM prompts").all()).toEqual([{ card_id: "R-1", field: "pcs" }]);
    db.exec("INSERT INTO prompts (chat_id, message_id, card_id, field, user_id) VALUES (-1, 6, NULL, 'search', 1)");
    expect(db.prepare("SELECT count(*) AS n FROM prompts").get()).toEqual({ n: 2 });
  });
});
