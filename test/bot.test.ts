// Повний шлях: повідомлення в гілці → картка → кнопки → рядок у (фейковій) таблиці.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Api } from "grammy";
import type { Update } from "grammy/types";
import type { AiBinding } from "../src/ai";
import { parseBookingRows } from "../src/bookings";
import { createBot } from "../src/bot";
import type { Env } from "../src/config";
import { resetTokenMemory } from "../src/google";
import { runCron, runPendingVerifications } from "../src/index";
import { BOOKINGS, SETTINGS, loadSettings } from "../src/sheet";
import { getCard } from "../src/store";
import { dateToSerial } from "../src/time";
import { FakeGoogle, makeServiceAccountKey } from "./fakeSheets";
import { CLUB_HOURS_ROWS, PC_LIST, fakeD1, sheetRow } from "./helpers";

const OWNER = 1000;
const ADMIN = 2000;
const CHAT = -100500;
const THREAD = 7;
const BOT_ID = 42;
// Четвер 19.11.2026, 16:00 за Варшавою.
const NOW = new Date("2026-11-19T15:00:00Z");
const FRI = dateToSerial(2026, 11, 20);

let rawKey: string;
beforeAll(async () => {
  rawKey = (await makeServiceAccountKey()).raw;
});

interface Call {
  method: string;
  payload: Record<string, any>;
}

let env: Env;
let google: FakeGoogle;
let calls: Call[];
let msgId: number;
let aiAnswer: unknown;
let deadline: number;

const ai: AiBinding = { run: async () => ({ response: aiAnswer }) };

beforeEach(() => {
  resetTokenMemory();
  google = new FakeGoogle();
  CLUB_HOURS_ROWS.forEach((r, i) => google.setRow(SETTINGS, 5 + i, r));
  PC_LIST.forEach((pc, i) => google.setRow(SETTINGS, 19 + i, [pc, pc === 18 || pc === 19 ? "Stream" : "Regular"]));
  google.set(SETTINGS, 15, 2, 12);
  google.set(BOOKINGS, 3, 5, dateToSerial(2026, 11, 16));
  google.setRow(BOOKINGS, 10, sheetRow({ date: FRI, b: 14, from: "18:00", to: "20:00", name: "Андрій", contact: "+48 501 234 567" }));
  env = {
    DB: fakeD1(),
    BOT_TOKEN: "1:test",
    WEBHOOK_SECRET: "s",
    GOOGLE_SA_KEY: rawKey,
    OWNER_ID: String(OWNER),
    TZ: "Europe/Warsaw",
    SHEET_ID: "SHEET",
    BOT_INFO: JSON.stringify({ id: BOT_ID, is_bot: true, first_name: "Бот", username: "res_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false }),
  };
  calls = [];
  msgId = 100;
  aiAnswer = null;
  deadline = Date.now() + 60_000;
});

async function handle(update: Omit<Update, "update_id">) {
  const bot = createBot(env, { deadline, now: () => NOW, fetch: google.fetch, ai });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    const result = method === "sendMessage" ? { message_id: ++msgId, date: 0, chat: { id: CHAT, type: "supergroup" }, text: "" } : true;
    return { ok: true, result } as any;
  });
  await bot.handleUpdate({ update_id: 1, ...update } as Update);
}

const user = (id: number, name: string) => ({ id, is_bot: false, first_name: name });
const chat = { id: CHAT, type: "supergroup" as const, title: "Клуб", is_forum: true };

function send(text: string, opts: { from?: number; thread?: number | null; replyTo?: number } = {}) {
  const thread = opts.thread === undefined ? THREAD : opts.thread;
  const from = opts.from ?? ADMIN;
  return handle({
    message: {
      message_id: ++msgId,
      date: 0,
      chat,
      from: user(from, from === OWNER ? "Власник" : "Сеня"),
      text,
      ...(thread ? { is_topic_message: true, message_thread_id: thread } : {}),
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}),
      ...(opts.replyTo ? { reply_to_message: { message_id: opts.replyTo, date: 0, chat, from: { id: BOT_ID, is_bot: true, first_name: "Бот" } } } : {}),
    } as any,
  });
}

function click(data: string, messageId: number, opts: { from?: number; thread?: number | null } = {}) {
  const thread = opts.thread === undefined ? THREAD : opts.thread;
  const from = opts.from ?? ADMIN;
  return handle({
    callback_query: {
      id: "q",
      chat_instance: "c",
      from: user(from, from === OWNER ? "Власник" : "Сеня"),
      data,
      message: { message_id: messageId, date: 0, chat, ...(thread ? { is_topic_message: true, message_thread_id: thread } : {}) },
    } as any,
  });
}

const last = (method: string) => [...calls].reverse().find((c) => c.method === method)!;
const toasts = () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.payload.text);
/** Останній текст картки (edit або send). */
const cardText = () => [...calls].reverse().find((c) => c.method === "editMessageText" || c.method === "sendMessage")!.payload.text as string;
const buttons = (c: Call) => (c.payload.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data ?? b.url);

async function bind() {
  await send("/start", { from: OWNER });
  await click(`bind|${THREAD}`, msgId, { from: OWNER });
  calls = [];
}

/** Надіслати бронь і повернути { id, message_id } картки. */
async function booking(text: string) {
  await send(text);
  const sent = calls.find((c) => c.method === "sendMessage")!;
  expect(sent).toBeTruthy();
  const cardMsg = msgId;
  const data = buttons(last("editMessageText"))[0] as string;
  const id = data.split("|")[1]!;
  return { id, cardMsg, sent };
}

describe("прив'язка гілки", () => {
  it("до прив'язки бот мовчить; не-власник не може прив'язати; власник — може, меню закріплюється", async () => {
    await send("пт пк 5 з 19 до 21 Олег tg");
    expect(calls).toEqual([]);

    await send("/start", { from: ADMIN });
    expect(last("sendMessage").payload).toMatchObject({ text: "Прив'язати гілку для бронювань може лише власник бота.", message_thread_id: THREAD });

    // Власник пише анонімно від імені групи — Telegram підставляє службовий акаунт.
    calls = [];
    await send("/start", { from: 1087968824 });
    expect(last("sendMessage").payload.text).toContain("Ви пишете анонімно");

    await send("/start", { from: OWNER });
    expect(last("sendMessage").payload).toMatchObject({ text: "Прив'язати цю гілку для бронювань?", message_thread_id: THREAD });

    await click(`bind|${THREAD}`, msgId, { from: ADMIN });
    expect(toasts()).toContain("Прив'язати гілку може лише власник");

    await click(`bind|${THREAD}`, msgId, { from: OWNER });
    const menu = last("sendMessage");
    expect(menu.payload.message_thread_id).toBe(THREAD);
    expect(menu.payload.text).toContain("Бронювання ПК");
    expect(last("pinChatMessage").payload.message_id).toBe(msgId);
  });

  it("після прив'язки: інша гілка і General — ігноруються", async () => {
    await bind();
    await send("пт пк 5 з 19 до 21 Олег tg", { thread: 99 });
    await send("пт пк 5 з 19 до 21 Олег tg", { thread: null });
    expect(calls).toEqual([]);
  });
});

describe("картка і запис", () => {
  beforeEach(bind);

  it("звичайна переписка — тиша", async () => {
    await send("Привіт, хто сьогодні на зміні?");
    await send("пк 12 не працює");
    expect(calls).toEqual([]);
  });

  it("звичайна бронь: картка у відповідь у ту саму гілку → ✅ → рядок у таблиці → статус K", async () => {
    const { id, cardMsg, sent } = await booking("пт пк 5 з 19 до 21 Олег +48 600 111 222");
    expect(sent.payload.message_thread_id).toBe(THREAD);
    expect(sent.payload.reply_parameters.message_id).toBe(cardMsg - 1);
    const text = cardText();
    expect(text).toContain("📅 Пт 20.11.2026");
    expect(text).toContain("💻 ПК 5 · Regular");
    expect(text).toContain("🕒 19:00 – 21:00 · 2 год");
    expect(text).toContain("👤 Олег · +48 600 111 222");
    expect(text).toContain("✅ Вільно");
    expect(buttons(last("editMessageText"))).toEqual([`s|${id}`, `e|${id}`, `c|${id}`]);

    await click(`s|${id}`, cardMsg);
    const rows = parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`));
    expect(rows.find((r) => r.botId === id)).toMatchObject({ row: 11, date: FRI, pcB: 5, pcC: null, from: 1140, to: 1260, name: "Олег", contact: "+48 600 111 222" });
    expect(cardText()).toContain("✅ Записано · рядок 11 · статус таблиці: ✓ OK · записав Сеня");
    expect(buttons(last("editMessageText"))).toEqual([`e|${id}`, `d|${id}`, "https://docs.google.com/spreadsheets/d/SHEET/edit"]);
    expect((await getCard(env.DB, id))!.verify_pending).toBe(0);

    // Друге натискання на стару кнопку не пише вдруге.
    await click(`s|${id}`, cardMsg);
    expect(toasts().at(-1)).toBe("Картку вже оброблено");
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`)).filter((r) => r.botId === id)).toHaveLength(1);
  });

  it("нічна бронь до 02:00 у пт — у годинах, «(до сб)»", async () => {
    await booking("пт пк 7 з 22 до 2 Макс tg");
    expect(cardText()).toContain("🕒 22:00 – 02:00 (до сб) · 4 год");
    expect(cardText()).toContain("✅ Вільно");
  });

  it("група ПК 12–17 — один рядок B=12, C=17", async () => {
    const { id, cardMsg } = await booking("пт пк 12-17 з 21 до 23 Дмитро tg");
    expect(cardText()).toContain("💻 ПК 12–17 (6 ПК) · Regular");
    await click(`s|${id}`, cardMsg);
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`)).find((r) => r.botId === id)).toMatchObject({ pcB: 12, pcC: 17 });
  });

  it("несуміжні ПК — кілька рядків з одним ID; 🗑 очищає всі", async () => {
    const { id, cardMsg } = await booking("пт пк 1, 3, 20 з 15 до 17 Ян tg");
    expect(cardText()).toContain("💻 ПК 1, 3, 20 (3 ПК)");
    await click(`s|${id}`, cardMsg);
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`)).filter((r) => r.botId === id).map((r) => r.pcB)).toEqual([1, 3, 20]);
    expect(cardText()).toContain("рядок 11, 12, 13");

    await click(`d|${id}`, cardMsg);
    expect(buttons(last("editMessageReplyMarkup"))).toEqual([`D|${id}`, `b|${id}`]);
    await click(`D|${id}`, cardMsg);
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`)).filter((r) => r.botId === id)).toEqual([]);
    expect(cardText()).toContain("🗑 Скасовано · Сеня, 19.11 16:00");
    expect(google.get(BOOKINGS, 10, 5)).toBe("Андрій"); // чужий рядок не чіпали
  });

  it("накладка: з ким і які ПК; лише «попри накладку» з підтвердженням", async () => {
    const { id, cardMsg } = await booking("пт пк 13-15 з 19 до 21 Олег tg");
    expect(cardText()).toContain("ПК 14 зайнятий: Андрій 18:00–20:00");
    expect(buttons(last("editMessageText"))).toEqual([`w|${id}`, `e|${id}`, `c|${id}`]);

    await click(`s|${id}`, cardMsg); // прямого «Записати» немає — навіть підроблене натискання перевіряється
    expect(google.calls.some((c) => c.url.includes("batchUpdate"))).toBe(false);
    expect(cardText()).toContain("Таблиця змінилась — перевірте ще раз");

    await click(`w|${id}`, cardMsg);
    expect(buttons(last("editMessageReplyMarkup"))).toEqual([`f|${id}`, `b|${id}`]);
    await click(`f|${id}`, cardMsg);
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`)).find((r) => r.botId === id)).toMatchObject({ pcB: 13, pcC: 15 });
  });

  it("впритул (20–22 після 18–20) — не накладка", async () => {
    await booking("пт пк 14 з 20 до 22 Ліна tg");
    expect(cardText()).toContain("✅ Вільно");
  });

  it("поза годинами і в минулому — попередження", async () => {
    await booking("пт пк 3 з 10 до 12 Іра tg");
    expect(cardText()).toContain("⏰ Поза годинами роботи (пт 12:00–06:00)");
    await booking("сьогодні пк 2 з 12 до 13 Ліна tg");
    expect(cardText()).toContain("🕓 Цей час уже минув");
  });

  it("неповна → ✏️ Доповнити → ForceReply у гілці → картка оновлюється", async () => {
    const { id, cardMsg } = await booking("пт пк 5 з 19 Ола");
    expect(cardText()).toContain("⚠ Не вистачає: час кінця");
    expect(buttons(last("editMessageText"))).toEqual([`e|${id}`, `c|${id}`]);

    await click(`e|${id}`, cardMsg);
    await click(`p:time|${id}`, cardMsg);
    const prompt = last("sendMessage");
    expect(prompt.payload).toMatchObject({ message_thread_id: THREAD, reply_markup: { force_reply: true, selective: true } });
    expect(prompt.payload.text).toContain('href="tg://user?id=2000"');
    const promptId = msgId;

    await send("ввечері", { replyTo: promptId }); // незрозуміло — перепитує
    expect(last("sendMessage").payload.text).toContain("не зрозумів час");
    await send("19-21", { replyTo: msgId });
    expect(cardText()).toContain("🕒 19:00 – 21:00 · 2 год");
    expect(cardText()).toContain("✅ Вільно");
    expect(buttons(last("editMessageText"))[0]).toBe(`s|${id}`);
    expect(calls.filter((c) => c.method === "deleteMessage").length).toBeGreaterThanOrEqual(3);
  });

  it("✏️ Змінити записану бронь: інший ПК → той самий рядок, той самий ID", async () => {
    const { id, cardMsg } = await booking("пт пк 5 з 19 до 21 Олег tg");
    await click(`s|${id}`, cardMsg);
    await click(`e|${id}`, cardMsg);
    expect(cardText()).toContain("✏️ <b>Зміна броні</b>");
    await click(`p:pcs|${id}`, cardMsg);
    await send("6-7", { replyTo: msgId });
    expect(cardText()).toContain("💻 ПК 6–7 (2 ПК)");
    expect(buttons(last("editMessageText"))).toEqual([`s|${id}`, `e|${id}`, `u|${id}`]);
    await click(`s|${id}`, cardMsg);
    const mine = parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`)).filter((r) => r.botId === id);
    expect(mine).toMatchObject([{ row: 11, pcB: 6, pcC: 7 }]);
    expect(cardText()).toContain("📌 <b>Бронь</b>");
  });

  it("❌ Відміна чернетки — без запису", async () => {
    const { id, cardMsg } = await booking("пт пк 5 з 19 до 21 Олег tg");
    await click(`c|${id}`, cardMsg);
    expect(cardText()).toContain("❌ <b>Відмінено</b>");
    expect(last("editMessageText").payload.reply_markup.inline_keyboard).toEqual([]);
    expect(google.calls.some((c) => c.url.includes("batchUpdate"))).toBe(false);
  });

  it("запасний розбір ШІ: заповнює лише те, чого бракує, і позначає це", async () => {
    aiAnswer = { date: "2026-11-25", pcs: [12], from: "19:00", to: "21:00", name: "Хтось", contact: null, note: null };
    await booking("пт пк дванадцять з 19 до 21 Олег tg");
    const text = cardText();
    expect(text).toContain("📅 Пт 20.11.2026"); // дату знайшов детермінований розбір — ШІ її не перебиває
    expect(text).toContain("💻 ПК 12");
    expect(text).toContain("👤 Олег · tg");
    expect(text).toContain("🤖 Частину розпізнав ШІ");
  });

  it("ШІ повернув сміття — картка з «Не вистачає»", async () => {
    aiAnswer = "не json";
    await booking("пт пк дванадцять з 19 до 21 Олег tg");
    expect(cardText()).toContain("⚠ Не вистачає: ПК");
  });

  it("статус таблиці розходиться з ботом — показуємо обидва", async () => {
    google.statusFor = () => "⚠ НАКЛАДКА: ПК вже зайнятий";
    const { id, cardMsg } = await booking("пт пк 5 з 19 до 21 Олег tg");
    await click(`s|${id}`, cardMsg);
    expect(cardText()).toContain("статус таблиці: ⚠ НАКЛАДКА: ПК вже зайнятий");
    expect(cardText()).toContain("❗ Перевірка бота (все гаразд) і таблиці розходяться");
  });

  it("не встигли перечитати K — дочитує Cron", async () => {
    const { id, cardMsg } = await booking("пт пк 5 з 19 до 21 Олег tg");
    deadline = Date.now() + 2_000; // бюджету на перечитування немає
    await click(`s|${id}`, cardMsg);
    expect(cardText()).toContain("статус таблиці: ⏳ перевіряю…");
    expect((await getCard(env.DB, id))!.verify_pending).toBe(1);

    // Cron: окремий виклик з власним Api (Telegram і Google — фейкові).
    const api = new Api(env.BOT_TOKEN);
    const telegram: string[] = [];
    api.config.use(async (_prev, method) => {
      telegram.push(method);
      return { ok: true, result: true } as any;
    });
    expect(await runPendingVerifications(env, Date.now() + 30_000, { api, fetch: google.fetch })).toBe(1);
    expect((await getCard(env.DB, id))!).toMatchObject({ k_status: "✓ OK", verify_pending: 0 });
    expect(telegram).toEqual(["editMessageText"]);
  });
});

describe("Google не відповідає — нічого не зависає", () => {
  beforeEach(bind);

  it("нова бронь: картка з помилкою і [🔄 Перевірити ще раз]; після відновлення — звичайна картка", async () => {
    await loadSettings({ db: env.DB, sheetId: "SHEET", saKey: rawKey, fetch: google.fetch }); // налаштування в кеші
    google.failReads = true;
    await send("пт пк 5 з 19 до 21 Олег tg");
    const cardMsg = msgId;
    expect(cardText()).toContain("❗ Не вдалося прочитати таблицю (Google Sheets 503");
    const [retry, cancel] = buttons(last("editMessageText")) as string[];
    expect(retry!.startsWith("k|")).toBe(true);
    expect(cancel!.startsWith("c|")).toBe(true);

    google.failReads = false;
    await click(retry!, cardMsg);
    expect(cardText()).toContain("✅ Вільно");
    expect(cardText()).not.toContain("❗");
  });

  it("меню: зрозуміле повідомлення замість тиші", async () => {
    google.failReads = true;
    await click("m:today", 1);
    expect(last("sendMessage").payload.text).toContain("❗ Не вдалося прочитати таблицю");
  });

  it("✏️ на записаній картці: помилка в картці, кнопки на місці", async () => {
    const { id, cardMsg } = await booking("пт пк 5 з 19 до 21 Олег tg");
    await click(`s|${id}`, cardMsg);
    google.failReads = true;
    await click(`e|${id}`, cardMsg);
    expect(cardText()).toContain("❗ Не вдалося: Google Sheets 503");
    expect(buttons(last("editMessageText"))[0]).toBe(`e|${id}`);
  });
});

describe("етап 4: нагадування і зведення (Cron)", () => {
  beforeEach(bind);

  /** Api для Cron: ті самі фейкові відповіді, що й у бота; `failSend` — Telegram відмовляє. */
  function cronApi(opts: { failSend?: boolean } = {}) {
    const api = new Api(env.BOT_TOKEN);
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, any> });
      if (opts.failSend && method === "sendMessage") return { ok: false, error_code: 429, description: "Too Many Requests" } as any;
      const result = method === "sendMessage" ? { message_id: ++msgId, date: 0, chat: { id: CHAT, type: "supergroup" }, text: "" } : true;
      if (method === "sendMessage") calls.at(-1)!.payload._message_id = msgId;
      return { ok: true, result } as any;
    });
    return api;
  }
  const cronAt = (iso: string, opts: { failSend?: boolean } = {}) =>
    runCron(env, { api: cronApi(opts), fetch: google.fetch, now: () => new Date(iso) });
  const sentTexts = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);

  it("пт 17:30: зведення дня (із запізненням) і нагадування за 30 хв — у гілку; повторний запуск — без дублів", async () => {
    const r = await cronAt("2026-11-20T16:30:00Z"); // 17:30 за Варшавою
    expect(r.reminders).toEqual({ sent: 2, failed: 0 });
    const [summary, reminder] = calls.filter((c) => c.method === "sendMessage");
    expect(summary!.payload).toMatchObject({ message_thread_id: THREAD });
    expect(summary!.payload.text).toContain("📅 <b>Сьогодні · пт 20.11</b> (12:00–06:00) — 1 бронювання");
    expect(summary!.payload.text).toContain("Зведення із запізненням (відкриття о 12:00)");
    expect(reminder!.payload.text).toBe("⏰ Через 30 хв (18:00–20:00): ПК 14 — Андрій (+48 501 234 567)");
    expect(buttons(reminder!).map((b: string) => b.split("|")[0])).toEqual(["a:y", "a:n"]);

    calls = [];
    expect((await cronAt("2026-11-20T16:35:00Z")).reminders).toEqual({ sent: 0, failed: 0 });
    expect(sentTexts()).toEqual([]);
  });

  it("[✅ Прийшов] → примітка в таблиці і в повідомленні; [❌ Не прийшов] — замінює відмітку", async () => {
    await cronAt("2026-11-20T16:30:00Z");
    const reminder = last("sendMessage");
    const reminderMsg = msgId;
    const [came, noShow] = buttons(reminder) as string[];

    await click(came!, reminderMsg);
    expect(google.get(BOOKINGS, 10, 7)).toBe("✅ прийшов (Сеня 16:00)");
    expect(last("editMessageText").payload.text).toContain("✅ Прийшов — відмітив Сеня, 19.11 16:00");
    expect(buttons(last("editMessageText"))).toEqual([came, noShow]); // можна передумати

    await click(noShow!, reminderMsg);
    expect(google.get(BOOKINGS, 10, 7)).toBe("❌ не прийшов (Сеня 16:00)");
    expect(google.calls.filter((c) => c.url.includes("batchUpdate")).at(-1)!.body.data).toEqual([
      { range: `'${BOOKINGS}'!H10`, values: [["❌ не прийшов (Сеня 16:00)"]] },
    ]);
  });

  it("бронь бота: відмітка шукається за ID; рядок видалили — кажемо, а не падаємо", async () => {
    const { id, cardMsg } = await booking("пт пк 5 з 21 до 23 Олег tg");
    await click(`s|${id}`, cardMsg);
    calls = [];
    await cronAt("2026-11-20T19:30:00Z"); // 20:30
    const reminder = calls.filter((c) => c.method === "sendMessage").find((c) => String(c.payload.text).startsWith("⏰ Через 30 хв (21:00"))!;
    expect(reminder.payload.text).toBe("⏰ Через 30 хв (21:00–23:00): ПК 5 — Олег (tg)");
    const reminderMsg = reminder.payload._message_id as number;
    const [came] = buttons(reminder) as string[];

    for (let c = 0; c <= 20; c++) google.set(BOOKINGS, 11, c, "");
    await click(came!, reminderMsg);
    expect(last("editMessageText").payload.text).toContain("❗ Броні в таблиці вже немає — відмітку не записано");
  });

  it("Telegram не прийняв повідомлення — ключ звільняється, наступний запуск надсилає", async () => {
    expect((await cronAt("2026-11-20T16:30:00Z", { failSend: true })).reminders).toEqual({ sent: 0, failed: 2 });
    calls = [];
    expect((await cronAt("2026-11-20T16:35:00Z")).reminders).toEqual({ sent: 2, failed: 0 });
    expect(sentTexts()[1]).toContain("⏰ Через 25 хв");
  });

  it("гілку не прив'язано — нічого не шлемо", async () => {
    await env.DB.prepare("DELETE FROM kv").run();
    expect((await cronAt("2026-11-20T16:30:00Z")).reminders).toMatchObject({ sent: 0, skipped: "гілку не прив'язано" });
  });
});

describe("етап 3: записана бронь, меню, журнал", () => {
  beforeEach(bind);

  /** Записати бронь через картку і повернути її ID та повідомлення. */
  async function saved(text: string) {
    const b = await booking(text);
    await click(`s|${b.id}`, b.cardMsg);
    expect(cardText()).toContain("✅ Записано");
    return b;
  }
  /** Людина вручну видалила рядки броні в таблиці. */
  function deleteRowsManually(id: string) {
    for (const r of parseBookingRows(google.read(`'${BOOKINGS}'!A10:U40`)).filter((x) => x.botId === id)) {
      for (let c = 0; c <= 20; c++) google.set(BOOKINGS, r.row, c, "");
    }
  }

  it("закріплене меню має 6 кнопок; повторний /start оновлює те саме меню", async () => {
    await send("/start", { from: OWNER });
    const edit = last("editMessageText");
    expect(edit.payload.text).toContain("Бронювання ПК");
    expect(buttons(edit)).toEqual(["m:today", "m:tomorrow", "m:free", "m:search", "m:new", "https://docs.google.com/spreadsheets/d/SHEET/edit"]);
    expect(calls.some((c) => c.method === "sendMessage")).toBe(false);
  });

  it("📅 Сьогодні / Завтра — у гілку, за часом", async () => {
    await click("m:today", 1);
    expect(last("sendMessage").payload).toMatchObject({ message_thread_id: THREAD });
    expect(last("sendMessage").payload.text).toContain("Сьогодні · чт 19.11</b> (12:00–06:00) — 0 бронювань");
    await click("m:tomorrow", 1);
    expect(last("sendMessage").payload.text).toContain("18:00–20:00 · ПК 14 · Андрій · +48 501 234 567");
  });

  it("🟢 Вільні зараз", async () => {
    await click("m:free", 1);
    expect(last("sendMessage").payload.text).toContain("🟢 <b>Вільні зараз</b> · чт 19.11 16:00");
    expect(last("sendMessage").payload.text).toContain("• ПК 1–29 — до закриття (06:00)");
  });

  it("🔎 Пошук: запит → відповідь → результат; запит і відповідь прибрано", async () => {
    await click("m:search", 1);
    const prompt = last("sendMessage");
    expect(prompt.payload.reply_markup).toMatchObject({ force_reply: true, selective: true });
    const promptId = msgId;
    await send("андр", { replyTo: promptId });
    expect(last("sendMessage").payload.text).toContain("🔎 <b>Пошук «андр»</b>");
    expect(last("sendMessage").payload.text).toContain("пт 20.11 18:00–20:00 · ПК 14 · Андрій");
    expect(calls.filter((c) => c.method === "deleteMessage").map((c) => c.payload.message_id)).toEqual([promptId, promptId + 1]);
  });

  it("➕ Бронь кнопками: дата кнопкою → ПК → час → ім'я → контакт → звичайна картка → запис", async () => {
    await click("m:new", 1);
    const card = last("sendMessage");
    const cardMsg = msgId;
    const dateButtons = buttons(card);
    expect(dateButtons.slice(0, 2).map((b: string) => b.split("|")[0])).toEqual([`nd:${FRI - 1}`, `nd:${FRI}`]);
    expect(card.payload.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["Сьогодні", "Завтра", "Сб 21.11"]);
    const id = dateButtons[0].split("|")[1];

    await click(`nd:${FRI}|${id}`, cardMsg);
    expect(last("editMessageText").payload.text).toContain("📅 Пт 20.11.2026");
    expect(last("editMessageText").payload.text).toContain("👉 Напишіть ПК");
    expect(last("sendMessage").payload.reply_markup).toMatchObject({ force_reply: true });
    for (const answer of ["5", "19-21", "Олег", "-"]) await send(answer, { replyTo: msgId });
    expect(cardText()).toContain("💻 ПК 5 · Regular");
    expect(cardText()).toContain("🕒 19:00 – 21:00 · 2 год");
    expect(cardText()).toContain("👤 Олег");
    expect(cardText()).toContain("✅ Вільно");
    await click(`s|${id}`, cardMsg);
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`)).find((r) => r.botId === id)).toMatchObject({ pcB: 5, name: "Олег", contact: "" });
  });

  it("➕ Бронь кнопками: «Інша дата» і помилка в кроці — перепитує", async () => {
    await click("m:new", 1);
    const cardMsg = msgId;
    const id = buttons(last("sendMessage"))[0].split("|")[1];
    await click(`nd:x|${id}`, cardMsg);
    await send("25.11", { replyTo: msgId });
    expect(last("editMessageText").payload.text).toContain("📅 Ср 25.11.2026");
    await send("сорок", { replyTo: msgId });
    expect(last("sendMessage").payload.text).toContain("не зрозумів ПК");
  });

  it("✏️ на записаній: рядок видалили вручну → кажемо про це; ➕ Записати заново — той самий ID", async () => {
    const { id, cardMsg } = await saved("пт пк 5 з 19 до 21 Олег tg");
    deleteRowsManually(id);
    await click(`e|${id}`, cardMsg);
    expect(cardText()).toContain("❗ У таблиці цієї броні вже немає — схоже, рядок видалили вручну");
    expect(buttons(last("editMessageText"))).toEqual([`R|${id}`, `X|${id}`]);

    await click(`R|${id}`, cardMsg);
    expect(cardText()).toContain("📝 <b>Нова бронь</b>");
    expect(cardText()).toContain("✅ Вільно");
    await click(`s|${id}`, cardMsg);
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`)).filter((r) => r.botId === id)).toHaveLength(1);
  });

  it("✖️ Закрити картку, якщо броні в таблиці немає", async () => {
    const { id, cardMsg } = await saved("пт пк 5 з 19 до 21 Олег tg");
    deleteRowsManually(id);
    await click(`e|${id}`, cardMsg);
    await click(`X|${id}`, cardMsg);
    expect(cardText()).toContain("Картку закрито: броні в таблиці немає");
    expect(last("editMessageText").payload.reply_markup.inline_keyboard).toEqual([]);
  });

  it("💾 Зберегти зміни, а рядок тим часом видалили — не падаємо, кажемо", async () => {
    const { id, cardMsg } = await saved("пт пк 5 з 19 до 21 Олег tg");
    await click(`e|${id}`, cardMsg);
    await click(`p:name|${id}`, cardMsg);
    await send("Олег Петренко", { replyTo: msgId });
    deleteRowsManually(id);
    await click(`s|${id}`, cardMsg);
    expect(cardText()).toContain("❗ У таблиці цієї броні вже немає");
    expect(buttons(last("editMessageText"))).toEqual([`R|${id}`, `X|${id}`]);
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`)).filter((r) => r.botId === id)).toEqual([]);
  });

  it("🗑, а рядок уже видалили вручну — картка закривається з поясненням", async () => {
    const { id, cardMsg } = await saved("пт пк 5 з 19 до 21 Олег tg");
    deleteRowsManually(id);
    await click(`d|${id}`, cardMsg);
    await click(`D|${id}`, cardMsg);
    expect(cardText()).toContain("🗑 Скасовано · Сеня");
    expect(cardText()).toContain("У таблиці цієї броні вже не було — рядок видалили вручну");
  });

  it("✏️ на записаній: бронь змінили в таблиці вручну і пересортували — беремо актуальні дані за ID", async () => {
    const { id, cardMsg } = await saved("пт пк 5 з 19 до 21 Олег tg");
    // Хтось вручну змінив «До» на 22:00 і пересортував: бронь переїхала з рядка 11 у рядок 25.
    for (let c = 0; c <= 20; c++) {
      const v = google.get(BOOKINGS, 11, c);
      google.set(BOOKINGS, 11, c, "");
      if (v !== undefined) google.set(BOOKINGS, 25, c, v);
    }
    google.set(BOOKINGS, 25, 4, 22 / 24);
    await click(`e|${id}`, cardMsg);
    expect(cardText()).toContain("🕒 19:00 – 22:00 · 3 год");
    expect(cardText()).toContain("У таблиці бронь змінили вручну");
    await click(`p:pcs|${id}`, cardMsg);
    await send("6", { replyTo: msgId });
    await click(`s|${id}`, cardMsg);
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U30`)).filter((r) => r.botId === id)).toMatchObject([{ row: 25, pcB: 6, to: 22 * 60 }]);
  });

  it("журнал: /log лише для власника; хто, коли, що", async () => {
    const { id, cardMsg } = await saved("пт пк 5 з 19 до 21 Олег tg");
    await click(`d|${id}`, cardMsg);
    await click(`D|${id}`, cardMsg);
    await click("m:today", 1);

    await send("/log", { from: ADMIN });
    expect(calls.some((c) => c.method === "sendMessage" && String(c.payload.text).includes("Останні дії"))).toBe(false);
    await send("/log", { from: OWNER });
    const log = last("sendMessage").payload.text as string;
    expect(log).toContain("📜 <b>Останні дії</b>");
    for (const what of ["Власник · 🔗 прив'язав гілку", "Сеня · 📝 картка з повідомлення", "Сеня · ✅ записав", "Сеня · 🗑 скасував бронь", "Сеня · 📅 сьогодні"]) {
      expect(log).toContain(what);
    }
    expect(log).toContain(`<code>${id}</code>`);
  });
});
