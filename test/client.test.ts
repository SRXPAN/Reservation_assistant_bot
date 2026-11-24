// Інтеграційні тести клієнтського режиму в особистих повідомленнях (`chat.type === 'private'`).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Api } from "grammy";
import type { Update } from "grammy/types";
import { parseBookingRows } from "../src/bookings";
import { createBot } from "../src/bot";
import { CLIENT_NOTE } from "../src/client_flow";
import type { Env } from "../src/config";
import { resetTokenMemory } from "../src/google";
import { runCron } from "../src/index";
import { safeError } from "../src/log";
import { BOOKINGS, SETTINGS } from "../src/sheet";
import { getClientBooking, getClientSession } from "../src/store";
import { dateToSerial } from "../src/time";
import { FakeGoogle, makeServiceAccountKey } from "./fakeSheets";
import { CLUB_HOURS_ROWS, PC_LIST, fakeD1, sheetRow } from "./helpers";

const OWNER = 1000;
const CLIENT_1 = 5001;
const CLIENT_2 = 5002;
const GROUP_CHAT = -100500;
const THREAD = 7;
const BOT_ID = 42;
// Четвер 19.11.2026, 16:00 за Варшавою.
const NOW = new Date("2026-11-19T15:00:00Z");
const THU = dateToSerial(2026, 11, 19);
const FRI = THU + 1;

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

beforeEach(() => {
  resetTokenMemory();
  google = new FakeGoogle();
  CLUB_HOURS_ROWS.forEach((r, i) => google.setRow(SETTINGS, 5 + i, r));
  PC_LIST.forEach((pc, i) => google.setRow(SETTINGS, 19 + i, [pc, pc === 18 || pc === 19 ? "Stream" : "Regular"]));
  google.set(SETTINGS, 15, 2, 12);
  google.set(BOOKINGS, 3, 5, dateToSerial(2026, 11, 16));
  env = {
    DB: fakeD1(),
    BOT_TOKEN: "1:test",
    WEBHOOK_SECRET: "s",
    GOOGLE_SA_KEY: rawKey,
    OWNER_ID: String(OWNER),
    TZ: "Europe/Warsaw",
    SHEET_ID: "SHEET",
    BOT_INFO: JSON.stringify({
      id: BOT_ID,
      is_bot: true,
      first_name: "Бот",
      username: "res_bot",
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
    }),
  };
  calls = [];
  msgId = 100;
});

async function handle(update: Omit<Update, "update_id">, nowDate: Date = NOW) {
  const bot = createBot(env, { deadline: Date.now() + 60_000, now: () => nowDate, fetch: google.fetch });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    const chatId = (payload as any).chat_id ?? GROUP_CHAT;
    const result =
      method === "sendMessage" ? { message_id: ++msgId, date: 0, chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" }, text: "" } : true;
    if (method === "sendMessage") calls.at(-1)!.payload._message_id = msgId;
    return { ok: true, result } as any;
  });
  await bot.handleUpdate({ update_id: 1, ...update } as Update);
}

const pmUser = (id: number, first_name: string, username?: string) => ({
  id,
  is_bot: false,
  first_name,
  ...(username ? { username } : {}),
});

async function bindGroup() {
  const chat = { id: GROUP_CHAT, type: "supergroup" as const, title: "Клуб", is_forum: true };
  await handle({
    message: {
      message_id: ++msgId,
      date: 0,
      chat,
      from: pmUser(OWNER, "Власник"),
      text: "/start",
      is_topic_message: true,
      message_thread_id: THREAD,
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    } as any,
  });
  await handle({
    callback_query: {
      id: "q",
      chat_instance: "c",
      from: pmUser(OWNER, "Власник"),
      data: `bind|${THREAD}`,
      message: { message_id: msgId, date: 0, chat, is_topic_message: true, message_thread_id: THREAD },
    } as any,
  });
  calls = [];
}

function sendPm(text: string, opts: { userId?: number; firstName?: string; username?: string } = {}) {
  const id = opts.userId ?? CLIENT_1;
  const chat = { id, type: "private" as const, first_name: opts.firstName ?? "Олексій" };
  return handle({
    message: {
      message_id: ++msgId,
      date: 0,
      chat,
      from: pmUser(id, opts.firstName ?? "Олексій", opts.username),
      text,
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}),
    } as any,
  });
}

function sendContact(phone_number: string, opts: { userId?: number; firstName?: string } = {}) {
  const id = opts.userId ?? CLIENT_2;
  const chat = { id, type: "private" as const, first_name: opts.firstName ?? "Марія" };
  return handle({
    message: {
      message_id: ++msgId,
      date: 0,
      chat,
      from: pmUser(id, opts.firstName ?? "Марія"),
      contact: { phone_number, first_name: opts.firstName ?? "Марія", user_id: id },
    } as any,
  });
}

function clickPm(data: string, messageId: number, opts: { userId?: number; firstName?: string; username?: string } = {}) {
  const id = opts.userId ?? CLIENT_1;
  const chat = { id, type: "private" as const, first_name: opts.firstName ?? "Олексій" };
  return handle({
    callback_query: {
      id: "q",
      chat_instance: "c",
      from: pmUser(id, opts.firstName ?? "Олексій", opts.username),
      data,
      message: { message_id: messageId, date: 0, chat },
    } as any,
  });
}

const last = (method: string) => [...calls].reverse().find((c) => c.method === method)!;
const lastText = () => [...calls].reverse().find((c) => c.method === "editMessageText" || c.method === "sendMessage")!.payload.text as string;
const buttons = (c: Call) => (c.payload.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data ?? b.url);

describe("клієнтський самозапис у ЛС", () => {
  beforeEach(bindGroup);

  it("/start у ЛС відкриває головне меню; довільний текст не запускає адмінський парсер", async () => {
    await sendPm("/start", { username: "alex" });
    const startMsg = last("sendMessage");
    expect(startMsg.payload.chat_id).toBe(CLIENT_1);
    expect(buttons(startMsg)).toEqual(["c:book", "c:my", "c:info"]);

    calls = [];
    // Навіть якщо текст схожий на адмінську бронь — в ЛС парсер не запускається.
    await sendPm("пт пк 5 з 19 до 21 Олег tg", { username: "alex" });
    expect(calls.some((c) => c.payload.text?.includes("Нова бронь"))).toBe(false);
    expect(last("sendMessage").payload.text).toContain("Користуйтесь кнопками меню");
  });

  it("📍 Адреса та графік підтягує актуальні години роботи та зони з таблиці", async () => {
    await sendPm("/start", { username: "alex" });
    const menuId = msgId;
    calls = [];
    await clickPm("c:info", menuId, { username: "alex" });
    expect(last("editMessageText").payload.text).toContain("Пн–Ср:</b> 12:00 – 00:00");
    expect(last("editMessageText").payload.text).toContain("Чт–Сб:</b> 12:00 – 06:00");
    expect(last("editMessageText").payload.text).toContain("Regular: 27 ПК");
    expect(last("editMessageText").payload.text).toContain("Stream: 2 ПК");
  });

  it("повний покроковий майстер (з @username, 1-клік ім'ям) редагує одне повідомлення, пише в таблицю і сповіщає адмінів", async () => {
    await sendPm("/start", { username: "alex_gamer" });
    const wizId = msgId;
    calls = [];

    await clickPm("c:book", wizId, { username: "alex_gamer" });
    expect(lastText()).toContain("Оберіть дату");
    expect(buttons(last("editMessageText"))).toContain(`c:d:${FRI}`);

    await clickPm(`c:d:${FRI}`, wizId, { username: "alex_gamer" });
    expect(buttons(last("editMessageText"))).toContain("c:z:0"); // Regular
    expect(buttons(last("editMessageText"))).toContain("c:z:1"); // Stream

    await clickPm("c:z:0", wizId, { username: "alex_gamer" }); // Regular
    expect(buttons(last("editMessageText"))).toContain("c:n:2");
    expect(buttons(last("editMessageText"))).toContain("c:more");
    expect(buttons(last("editMessageText"))).toContain("c:pick");

    await clickPm("c:n:2", wizId, { username: "alex_gamer" }); // 2 ПК
    expect(lastText()).toContain("Оберіть час початку");
    expect(buttons(last("editMessageText"))).toContain(`c:t:${FRI * 1440 + 19 * 60}`);

    await clickPm(`c:t:${FRI * 1440 + 19 * 60}`, wizId, { username: "alex_gamer" });
    expect(lastText()).toContain("Оберіть тривалість");
    expect(buttons(last("editMessageText"))).toContain("c:dur:180");

    await clickPm("c:dur:180", wizId, { username: "alex_gamer" }); // 3 год -> 19:00-22:00
    expect(lastText()).toContain("Ваше ім'я");
    expect(buttons(last("editMessageText"))).toContain("c:nm:tg");

    await clickPm("c:nm:tg", wizId, { username: "alex_gamer" });
    expect(lastText()).toContain("@alex_gamer");
    expect(buttons(last("editMessageText"))).toContain("c:ct:skip");
    expect(buttons(last("editMessageText"))).toContain("c:ct:phone");

    await clickPm("c:ct:skip", wizId, { username: "alex_gamer" });
    expect(lastText()).toContain("Перевірте деталі бронювання");
    expect(lastText()).toContain("ПК 20–21 (2 ПК)");
    expect(lastText()).toContain("@alex_gamer");

    // Переконаємось, що весь шлях ішов через редагування одного повідомлення (жодного sendMessage до підтвердження).
    expect(calls.some((c) => c.method === "sendMessage")).toBe(false);

    await clickPm("c:ok", wizId, { username: "alex_gamer" });
    expect(last("editMessageText").payload.text).toContain("✅ <b>Бронь підтверджено!</b>");

    const rows = parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`));
    expect(rows).toHaveLength(1);
    const saved = rows[0]!;
    expect(saved).toMatchObject({
      date: FRI,
      pcB: 20,
      pcC: 21,
      from: 19 * 60,
      to: 22 * 60,
      name: "Олексій",
      contact: "@alex_gamer",
      note: CLIENT_NOTE,
    });
    expect(saved.botId).toMatch(/^R-/);
    expect(await getClientBooking(env.DB, saved.botId)).toMatchObject({ client_tg_id: CLIENT_1, status: "active" });
    expect(await getClientSession(env.DB, CLIENT_1)).toBeNull();

    // Сповіщення в прив'язану адмінську гілку.
    const adminNote = calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === GROUP_CHAT)!;
    expect(adminNote.payload.message_thread_id).toBe(THREAD);
    expect(adminNote.payload.text).toContain("🆕 Нова бронь від клієнта:");
    expect(adminNote.payload.text).toContain("ПК 20–21 (2 ПК) (Regular)");
    expect(adminNote.payload.text).toContain("Олексій (@alex_gamer)");
  });

  it("ручне введення імені та обов'язковий телефон без @username (текст + кнопка контакту)", async () => {
    await sendPm("/start", { userId: CLIENT_2, firstName: "Марія" });
    const wizId = msgId;

    await clickPm("c:book", wizId, { userId: CLIENT_2, firstName: "Марія" });
    await clickPm(`c:d:${FRI}`, wizId, { userId: CLIENT_2, firstName: "Марія" });
    await clickPm("c:z:1", wizId, { userId: CLIENT_2, firstName: "Марія" }); // Stream
    await clickPm("c:n:1", wizId, { userId: CLIENT_2, firstName: "Марія" });
    await clickPm(`c:t:${FRI * 1440 + 20 * 60}`, wizId, { userId: CLIENT_2, firstName: "Марія" });
    await clickPm("c:dur:120", wizId, { userId: CLIENT_2, firstName: "Марія" });

    await clickPm("c:nm:edit", wizId, { userId: CLIENT_2, firstName: "Марія" });
    await sendPm("Марія Коваль", { userId: CLIENT_2, firstName: "Марія" });
    // Без username — одразу просить телефон + надсилає ReplyKeyboard з request_contact.
    expect(last("editMessageText").payload.text).toContain("Контакт для зв'язку");
    const replyPrompt = calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(replyPrompt.payload.reply_markup.keyboard[0][0]).toMatchObject({ request_contact: true });

    // Некоректний телефон -> перепитує
    await sendPm("abc", { userId: CLIENT_2, firstName: "Марія" });
    expect(last("editMessageText").payload.text).toContain("Некоректний номер телефону");

    // Надсилання контакту кнопкою -> картка перевірки
    await sendContact("48501234567", { userId: CLIENT_2, firstName: "Марія" });
    expect(last("editMessageText").payload.text).toContain("Марія Коваль");
    expect(last("editMessageText").payload.text).toContain("+48501234567");

    await clickPm("c:ok", wizId, { userId: CLIENT_2, firstName: "Марія" });
    const rows = parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`));
    expect(rows[0]).toMatchObject({ pcB: 18, name: "Марія Коваль", contact: "+48501234567", note: CLIENT_NOTE });
  });

  it("вибір конкретних номерів ПК показує вільні слоти саме для них і записує обрані ПК", async () => {
    // ПК 5 зайнятий у пт о 19:00–21:00
    google.setRow(BOOKINGS, 10, sheetRow({ date: FRI, b: 5, from: "19:00", to: "21:00", name: "Хтось" }));
    await sendPm("/start", { username: "alex" });
    const wizId = msgId;

    await clickPm("c:book", wizId, { username: "alex" });
    await clickPm(`c:d:${FRI}`, wizId, { username: "alex" });
    await clickPm("c:z:0", wizId, { username: "alex" });
    await clickPm("c:pick", wizId, { username: "alex" });
    await clickPm("c:pc:5", wizId, { username: "alex" });
    await clickPm("c:pc:7", wizId, { username: "alex" });
    await clickPm("c:pcok", wizId, { username: "alex" });

    const timeBtns = buttons(last("editMessageText"));
    // 19:00 і 20:00 недоступні, бо ПК 5 зайнятий! А 18:00 (18-19) і 21:00 — доступні!
    expect(timeBtns).not.toContain(`c:t:${FRI * 1440 + 19 * 60}`);
    expect(timeBtns).not.toContain(`c:t:${FRI * 1440 + 20 * 60}`);
    expect(timeBtns).toContain(`c:t:${FRI * 1440 + 21 * 60}`);

    await clickPm(`c:t:${FRI * 1440 + 21 * 60}`, wizId, { username: "alex" });
    await clickPm("c:dur:120", wizId, { username: "alex" });
    await clickPm("c:nm:tg", wizId, { username: "alex" });
    await clickPm("c:ct:skip", wizId, { username: "alex" });
    await clickPm("c:ok", wizId, { username: "alex" });

    const mine = parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`)).filter((r) => r.note === CLIENT_NOTE);
    expect(mine.map((r) => r.pcB)).toEqual([5, 7]);
  });

  it("повторна перевірка при підтвердженні: якщо ПК зайняли під час кліків — не створює накладку і пропонує вільні слоти", async () => {
    await sendPm("/start", { username: "alex" });
    const wizId = msgId;
    await clickPm("c:book", wizId, { username: "alex" });
    await clickPm(`c:d:${FRI}`, wizId, { username: "alex" });
    await clickPm("c:z:1", wizId, { username: "alex" }); // Stream: 18, 19
    await clickPm("c:n:2", wizId, { username: "alex" });
    await clickPm(`c:t:${FRI * 1440 + 19 * 60}`, wizId, { username: "alex" });
    await clickPm("c:dur:120", wizId, { username: "alex" });
    await clickPm("c:nm:tg", wizId, { username: "alex" });
    await clickPm("c:ct:skip", wizId, { username: "alex" });

    // Поки клієнт думав, адмін зайняв ПК 18 на 19:00–21:00 у таблиці!
    google.setRow(BOOKINGS, 10, sheetRow({ date: FRI, b: 18, from: "19:00", to: "21:00", name: "Адмінська" }));
    calls = [];

    await clickPm("c:ok", wizId, { username: "alex" });
    expect(last("editMessageText").payload.text).toContain("ці ПК щойно зайняли");
    expect(buttons(last("editMessageText"))).toContain(`c:t:${FRI * 1440 + 21 * 60}`);
    // У таблиці лише адмінська бронь, накладки немає.
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`))).toHaveLength(1);
  });

  it("ліміт макс. 2 активні броні, «Мої броні» і самостійне скасування зі сповіщенням адмінам", async () => {
    async function bookQuick(hour: number) {
      await sendPm("/start", { username: "alex" });
      const w = msgId;
      await clickPm("c:book", w, { username: "alex" });
      await clickPm(`c:d:${FRI}`, w, { username: "alex" });
      await clickPm("c:z:0", w, { username: "alex" });
      await clickPm("c:n:1", w, { username: "alex" });
      await clickPm(`c:t:${FRI * 1440 + hour * 60}`, w, { username: "alex" });
      await clickPm("c:dur:60", w, { username: "alex" });
      await clickPm("c:nm:tg", w, { username: "alex" });
      await clickPm("c:ct:skip", w, { username: "alex" });
      await clickPm("c:ok", w, { username: "alex" });
      return w;
    }

    await bookQuick(18);
    await bookQuick(20);

    // 3-тя спроба заблокована
    await sendPm("/start", { username: "alex" });
    const menuId = msgId;
    await clickPm("c:book", menuId, { username: "alex" });
    expect(last("editMessageText").payload.text).toContain("Досягнуто ліміт бронювань");
    expect(buttons(last("editMessageText"))).toContain("c:my");

    // Перегляд «Мої броні» і скасування першої броні
    await clickPm("c:my", menuId, { username: "alex" });
    const myBtns = buttons(last("editMessageText"));
    const cancelBtn = myBtns.find((b: string) => b.startsWith("c:mycan:"))!;
    const bookingId = cancelBtn.slice("c:mycan:".length);

    await clickPm(cancelBtn, menuId, { username: "alex" });
    calls = [];
    await clickPm(`c:mycanok:${bookingId}`, menuId, { username: "alex" });
    expect(last("editMessageText").payload.text).toContain("Бронь скасовано");
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`))).toHaveLength(1);
    expect(await getClientBooking(env.DB, bookingId)).toMatchObject({ status: "cancelled" });

    const adminCancelMsg = calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === GROUP_CHAT)!;
    expect(adminCancelMsg.payload.text).toContain("🗑 Клієнт скасував бронь:");

    // Тепер знову можна бронювати!
    await clickPm("c:menu", menuId, { username: "alex" });
    await clickPm("c:book", menuId, { username: "alex" });
    expect(last("editMessageText").payload.text).toContain("Оберіть дату");
  });

  it("двосторонні нагадування за 30 хв: клієнт отримує в ЛС і може підтвердити або скасувати", async () => {
    await sendPm("/start", { username: "alex" });
    const w = msgId;
    await clickPm("c:book", w, { username: "alex" });
    await clickPm(`c:d:${FRI}`, w, { username: "alex" });
    await clickPm("c:z:0", w, { username: "alex" });
    await clickPm("c:n:1", w, { username: "alex" });
    await clickPm(`c:t:${FRI * 1440 + 19 * 60}`, w, { username: "alex" });
    await clickPm("c:dur:120", w, { username: "alex" });
    await clickPm("c:nm:tg", w, { username: "alex" });
    await clickPm("c:ct:skip", w, { username: "alex" });
    await clickPm("c:ok", w, { username: "alex" });

    const bookingId = parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`))[0]!.botId;
    calls = [];

    // Пт 18:30 за Варшавою (17:30 UTC) — за 30 хв до 19:00
    const api = new Api(env.BOT_TOKEN);
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, any> });
      const chatId = (payload as any).chat_id;
      const result = method === "sendMessage" ? { message_id: ++msgId, date: 0, chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" }, text: "" } : true;
      if (method === "sendMessage") calls.at(-1)!.payload._message_id = msgId;
      return { ok: true, result } as any;
    });
    const cronRes = await runCron(env, { api, fetch: google.fetch, now: () => new Date("2026-11-20T17:30:00Z") });
    expect(cronRes.reminders.sent).toBe(3); // зведення адміну + нагадування адміну + нагадування клієнту

    const clientRem = calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === CLIENT_1)!;
    expect(clientRem.payload.text).toBe("⏰ Нагадуємо: ваша бронь ПК 20 починається о 19:00 (через 30 хв). Все в силі?");
    expect(buttons(clientRem)).toEqual([`c:rem:ok:${bookingId}`, `c:rem:can:${bookingId}`]);
    const remMsgId = clientRem.payload._message_id as number;

    // Клієнт натискає «👍 Буду вчасно»
    await handle(
      {
        callback_query: {
          id: "q",
          chat_instance: "c",
          from: pmUser(CLIENT_1, "Олексій", "alex"),
          data: `c:rem:ok:${bookingId}`,
          message: { message_id: remMsgId, date: 0, chat: { id: CLIENT_1, type: "private" } },
        } as any,
      },
      new Date("2026-11-20T17:32:00Z"),
    );
    expect(google.get(BOOKINGS, 10, 7)).toBe("клієнт через бот · клієнт підтвердив (18:32)");
    expect(last("editMessageText").payload.text).toContain("👍 Підтверджено о 18:32!");

    // Повторний Cron не дублює клієнтське нагадування
    calls = [];
    const cronRes2 = await runCron(env, { api, fetch: google.fetch, now: () => new Date("2026-11-20T17:35:00Z") });
    expect(cronRes2.reminders.sent).toBe(0);

    // Або клієнт може скасувати бронь прямо з нагадування
    await clickPm(`c:rem:can:${bookingId}`, remMsgId, { username: "alex" });
    await clickPm(`c:rem:canok:${bookingId}`, remMsgId, { username: "alex" });
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`))).toEqual([]);
    expect(calls.some((c) => c.method === "sendMessage" && c.payload.chat_id === GROUP_CHAT && String(c.payload.text).includes("Клієнт скасував бронь"))).toBe(true);
  });

  it("клієнт у DM бачить лише статус зайнятості без PII чужих гостей (c:info та накладка)", async () => {
    google.setRow(
      BOOKINGS,
      10,
      sheetRow({ date: THU, b: 18, from: "15:00", to: "20:00", name: "ТаємнийГість", contact: "+48 111 222 333" }),
    );
    google.setRow(
      BOOKINGS,
      11,
      sheetRow({ date: FRI, b: 19, from: "19:00", to: "22:00", name: "СекретнаОльга", contact: "@secret_olga" }),
    );

    await sendPm("/start", { username: "alex" });
    const wizId = msgId;
    await clickPm("c:info", wizId, { username: "alex" });
    const infoText = last("editMessageText").payload.text as string;
    expect(infoText).toContain("<b>Stream:</b> вільно 1 з 2 ПК");
    expect(infoText).not.toContain("ТаємнийГість");
    expect(infoText).not.toContain("111 222 333");
    expect(infoText).not.toContain("СекретнаОльга");
    expect(infoText).not.toContain("@secret_olga");

    // Також під час вибору часу не з'являються імена інших гостей
    await clickPm("c:book", wizId, { username: "alex" });
    await clickPm(`c:d:${FRI}`, wizId, { username: "alex" });
    await clickPm("c:z:1", wizId, { username: "alex" });
    await clickPm("c:n:2", wizId, { username: "alex" });
    const timeMsg = last("editMessageText").payload.text as string;
    expect(timeMsg).not.toContain("СекретнаОльга");
    expect(timeMsg).not.toContain("@secret_olga");
  });

  it("IDOR-захист: клієнт Б не може переглядати, підтверджувати чи скасовувати бронь клієнта А підміною bookingId", async () => {
    await sendPm("/start", { username: "alex" });
    const w = msgId;
    await clickPm("c:book", w, { username: "alex" });
    await clickPm(`c:d:${FRI}`, w, { username: "alex" });
    await clickPm("c:z:0", w, { username: "alex" });
    await clickPm("c:n:1", w, { username: "alex" });
    await clickPm(`c:t:${FRI * 1440 + 19 * 60}`, w, { username: "alex" });
    await clickPm("c:dur:120", w, { username: "alex" });
    await clickPm("c:nm:tg", w, { username: "alex" });
    await clickPm("c:ct:skip", w, { username: "alex" });
    await clickPm("c:ok", w, { username: "alex" });

    const bookingId = parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`))[0]!.botId;

    // Клієнт Б (CLIENT_2) відкриває меню і пробує підставити bookingId клієнта А в усі можливі callback_data
    await sendPm("/start", { userId: CLIENT_2, firstName: "Зловмисник" });
    const attackerMsgId = msgId;

    const idorPayloads = [
      `c:myview:${bookingId}`,
      `c:mycan:${bookingId}`,
      `c:mycanok:${bookingId}`,
      `c:rem:ok:${bookingId}`,
      `c:rem:can:${bookingId}`,
      `c:rem:canok:${bookingId}`,
      `c:rem:back:${bookingId}`,
    ];
    for (const payload of idorPayloads) {
      calls = [];
      await clickPm(payload, attackerMsgId, { userId: CLIENT_2, firstName: "Зловмисник" });
      const ans = calls.find((c) => c.method === "answerCallbackQuery");
      expect(ans?.payload.text).toBe("Бронь недоступна.");
      // Жодних повідомлень із деталями жертви чи змін у таблиці не має бути
      expect(calls.some((c) => c.method === "editMessageText" || c.method === "sendMessage")).toBe(false);
    }

    // Бронь клієнта А залишилась активною і недоторканою
    expect(parseBookingRows(google.read(`'${BOOKINGS}'!A10:U20`))).toHaveLength(1);
    expect(await getClientBooking(env.DB, bookingId)).toMatchObject({ client_tg_id: CLIENT_1, status: "active" });

    // А сам власник (CLIENT_1) може переглядати деталі своєї броні через c:myview
    calls = [];
    await clickPm(`c:myview:${bookingId}`, w, { username: "alex" });
    expect(last("editMessageText").payload.text).toContain("Деталі бронювання");
    expect(last("editMessageText").payload.text).toContain("@alex");
  });

  it("гігієна логів: safeError приховує payload.text, номери телефонів та @username", () => {
    const fakeGrammyErr = {
      name: "GrammyError",
      error_code: 400,
      description: "Bad Request: phone +48 501 234 567 or @secret_client invalid",
      payload: { chat_id: 123, text: "Олександр +48 501 234 567 секрет" },
    };
    const out = safeError(fakeGrammyErr);
    expect(out).not.toContain("+48 501 234 567");
    expect(out).not.toContain("@secret_client");
    expect(out).not.toContain("Олександр");
    expect(out).toContain("[redacted-phone]");
    expect(out).toContain("[redacted-user]");
  });
});
