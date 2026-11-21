import { describe, expect, it } from "vitest";
import { normalizeContact, parseBooking, parseDateInput, parsePcsInput, parseTimeInput } from "../src/parse";
import { dateToSerial } from "../src/time";
import { PC_LIST } from "./helpers";

// «Сьогодні» в тестах — четвер 19.11.2026.
const TODAY = dateToSerial(2026, 11, 19);
const ctx = { today: TODAY, pcList: PC_LIST };
const H = 60;
const parse = (text: string) => parseBooking(text, ctx);
const D = (d: number, m: number, y = 2026) => dateToSerial(y, m, d);

describe("приклади з SPEC.md", () => {
  it("«пт 18 пк 12-17 з 19 до 2 Vova tg» — 18 — число місяця (пт 18.12)", () => {
    const { draft, signals, missing } = parse("пт 18 пк 12-17 з 19 до 2 Vova tg");
    expect(signals).toBe(true);
    expect(missing).toEqual([]);
    expect(draft).toMatchObject({ date: D(18, 12), pcs: [12, 13, 14, 15, 16, 17], from: 19 * H, to: 2 * H, name: "Vova", contact: "tg", note: "" });
    expect(draft.hints).toEqual([]); // 18.12.2026 — справді п'ятниця
  });

  it("«21.11 ПК 18 16:00-19:00 Андрій +48 501 234 567»", () => {
    const { draft, missing } = parse("21.11 ПК 18 16:00-19:00 Андрій +48 501 234 567");
    expect(missing).toEqual([]);
    expect(draft).toMatchObject({ date: D(21, 11), pcs: [18], from: 16 * H, to: 19 * H, name: "Андрій", contact: "+48 501 234 567", note: "" });
  });

  it("«завтра 12-14 пк, 18:00–22:00, Олег, insta, день народження»", () => {
    const { draft, missing } = parse("завтра 12-14 пк, 18:00–22:00, Олег, insta, день народження");
    expect(missing).toEqual([]);
    expect(draft).toMatchObject({ date: TODAY + 1, pcs: [12, 13, 14], from: 18 * H, to: 22 * H, name: "Олег", contact: "insta", note: "день народження" });
  });

  it("«сьогодні 5 пк на 3 години з 20:00 Марта 0671234567» — ПК №5, 20:00–23:00", () => {
    const { draft, missing } = parse("сьогодні 5 пк на 3 години з 20:00 Марта 0671234567");
    expect(missing).toEqual([]);
    expect(draft).toMatchObject({ date: TODAY, pcs: [5], from: 20 * H, to: 23 * H, name: "Марта", contact: "0671234567", note: "" });
  });
});

describe("ще 15+ власних прикладів", () => {
  const cases: [string, Partial<ReturnType<typeof parse>["draft"]>][] = [
    // 1. Несуміжні ПК через кому
    ["сб пк 12,14,16 з 18 до 23 Ігор tg", { date: D(21, 11), pcs: [12, 14, 16], from: 18 * H, to: 23 * H, name: "Ігор", contact: "tg" }],
    // 2. Суміжні + окремий
    ["21/11 пк 1-3, 7 19:00-21:00 Den insta", { date: D(21, 11), pcs: [1, 2, 3, 7], from: 19 * H, to: 21 * H, name: "Den", contact: "insta" }],
    // 3. Повна дата з роком і прізвище
    ["25.12.2026 пк 20 з 14:00 до 18:30 Андрій Петренко +380 67 123 45 67", { date: D(25, 12), pcs: [20], from: 14 * H, to: 18 * H + 30, name: "Андрій Петренко", contact: "+380 67 123 45 67" }],
    // 4. Післязавтра (не «завтра»!)
    ["післязавтра пк 9 з 12 до 15 Оля дзвінок", { date: TODAY + 2, pcs: [9], from: 12 * H, to: 15 * H, name: "Оля", contact: "дзвінок" }],
    // 5. «у п'ятницю» з апострофом-лапкою і «18 пк» (єдиний «пк» → це ПК, а не дата)
    ["у п’ятницю 18 пк з 22 до 4 Макс", { date: D(20, 11), pcs: [18], from: 22 * H, to: 4 * H, name: "Макс" }],
    // 6. Тривалість «на 2,5 год»
    ["завтра пк 3 з 17:30 на 2,5 год Ян", { date: TODAY + 1, pcs: [3], from: 17 * H + 30, to: 20 * H, name: "Ян" }],
    // 7. «на півтори години»
    ["сьогодні пк 4 з 21 на півтори години Саша tg", { date: TODAY, pcs: [4], from: 21 * H, to: 22 * H + 30, name: "Саша", contact: "tg" }],
    // 8. Дата словами
    ["22 листопада пк 10 16-18 Ліза", { date: D(22, 11), pcs: [10], from: 16 * H, to: 18 * H, name: "Ліза" }],
    // 9. Сьогоднішній день тижня — це сьогодні
    ["чт пк 6 з 20 до 22 Bob", { date: TODAY, pcs: [6], from: 20 * H, to: 22 * H, name: "Bob" }],
    // 10. Неділя, «ПК з 25 по 29»
    ["нд ПК з 25 по 29 з 12:00 до 15:30 Олег +48 600 111 222", { date: D(22, 11), pcs: [25, 26, 27, 28, 29], from: 12 * H, to: 15 * H + 30, name: "Олег", contact: "+48 600 111 222" }],
    // 11. Порядок слів довільний, ім'я першим
    ["Марко, пк 15, завтра, 13:00-14:00", { date: TODAY + 1, pcs: [15], from: 13 * H, to: 14 * H, name: "Марко" }],
    // 12. Ім'я з малої + примітка після нього
    ["21.11 пк 2 18-20 sasha insta прийде з другом", { date: D(21, 11), pcs: [2], from: 18 * H, to: 20 * H, name: "sasha", contact: "insta", note: "прийде з другом" }],
    // 13. «Прошу забронювати…» — службові слова не стають іменем
    ["Прошу забронювати пк 11 на завтра з 19 до 21, Тарас", { date: TODAY + 1, pcs: [11], from: 19 * H, to: 21 * H, name: "Тарас" }],
    // 14. Дата минулого тижня → цей рік (попередження «у минулому» дасть перевірка)
    ["15.11 пк 1 12-13 Тест", { date: D(15, 11), pcs: [1], from: 12 * H, to: 13 * H }],
    // 15. Дата давно минула → наступний рік
    ["03.01 пк 1 12-13 Новорічний", { date: D(3, 1, 2027), pcs: [1] }],
    // 16. Ніч до 24:00 і час з крапкою
    ["пт пк 8 з 20.00 до 24:00 Ігор", { date: D(20, 11), pcs: [8], from: 20 * H, to: 24 * H, name: "Ігор" }],
    // 17. Телеграм-нік
    ["завтра пк 19 18:00-21:00 @vova_gamer", { date: TODAY + 1, pcs: [19], from: 18 * H, to: 21 * H, contact: "@vova_gamer" }],
    // 18. Російською
    ["завтра пк 7 с 18 до 20 Дима телеграм", { date: TODAY + 1, pcs: [7], from: 18 * H, to: 20 * H, name: "Дима", contact: "tg" }],
  ];
  it.each(cases)("%s", (text, expected) => {
    const { draft, signals } = parse(text);
    expect(signals).toBe(true);
    expect(draft).toMatchObject(expected);
  });
});

describe("неповні й сумнівні", () => {
  it("без імені і кінця — список чого не вистачає", () => {
    const { draft, signals, missing } = parse("завтра пк 5 з 19");
    expect(signals).toBe(true);
    expect(draft).toMatchObject({ pcs: [5], from: 19 * H, to: null });
    expect(missing).toEqual(["час кінця", "ім'я"]);
  });

  it("без дати", () => {
    expect(parse("пк 5 з 19 до 21 Олег").missing).toEqual(["дата"]);
  });

  it("день тижня не збігається з числом — підказка", () => {
    const { draft } = parse("сб 18 пк 1-2 з 19 до 21 Вова");
    expect(draft.date).toBe(D(18, 12)); // число важливіше, але…
    expect(draft.hints[0]).toMatch(/18\.12\.2026 — це пт, а не сб/);
  });

  it("ПК поза списком", () => {
    const { draft } = parse("завтра пк 35 з 19 до 21 Вова");
    expect(draft.pcs).toEqual([]);
    expect(draft.hints[0]).toMatch(/ПК 35 немає/);
  });
});

describe("звичайна переписка — бот мовчить", () => {
  it.each([
    "Привіт, хто сьогодні на зміні?",
    "пк 12 не працює, перезавантажте",
    "буду о 19:00",
    "Купіть каву, будь ласка",
    "завтра прибирання з 10 до 12",
    "Сеня, глянь 5 пк, там миша погана",
    "ок",
    "21.11 у мене вихідний",
  ])("%s", (text) => {
    expect(parse(text).signals).toBe(false);
  });
});

describe("окремі поля (при зміні)", () => {
  it("ПК без слова «пк»", () => {
    expect(parsePcsInput("12-17", PC_LIST).pcs).toEqual([12, 13, 14, 15, 16, 17]);
    expect(parsePcsInput("12, 14, 16", PC_LIST).pcs).toEqual([12, 14, 16]);
    expect(parsePcsInput("пк 3", PC_LIST).pcs).toEqual([3]);
    expect(parsePcsInput("40", PC_LIST).hints[0]).toMatch(/40/);
  });
  it("час", () => {
    expect(parseTimeInput("19-2")).toEqual({ from: 19 * H, to: 2 * H });
    expect(parseTimeInput("з 20:00 на 3 години")).toEqual({ from: 20 * H, to: 23 * H });
    expect(parseTimeInput("18:30–22:00")).toEqual({ from: 18 * H + 30, to: 22 * H });
    expect(parseTimeInput("ввечері")).toBeNull();
  });
  it("дата", () => {
    expect(parseDateInput("завтра", ctx).date).toBe(TODAY + 1);
    expect(parseDateInput("пт", ctx).date).toBe(D(20, 11));
    expect(parseDateInput("1.12", ctx).date).toBe(D(1, 12));
    expect(parseDateInput("25", ctx).date).toBe(D(25, 11));
    expect(parseDateInput("10", ctx).date).toBe(D(10, 12));
  });
  it("контакт", () => {
    expect(normalizeContact("телеграм")).toBe("tg");
    expect(normalizeContact("Інстаграм")).toBe("insta");
    expect(normalizeContact("+48 123 456 789")).toBe("+48 123 456 789");
  });
});
