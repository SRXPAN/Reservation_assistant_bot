import { Api } from "grammy";
import type { Update } from "grammy/types";
import type { AiBinding } from "./ai";
import { createBot } from "./bot";
import type { Env } from "./config";
import { verifyCard, type Deps } from "./flow";
import { runReminders, type RunResult } from "./reminders";
import { loadSettings } from "./sheet";
import { getBinding, pendingVerifications } from "./store";

const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"] as const;
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
/** waitUntil живе до 30 с після відповіді; лишаємо запас. */
const BACKGROUND_BUDGET_MS = 27_000;
/** Бюджет одного запуску Cron. */
const CRON_BUDGET_MS = 50_000;

type FullEnv = Env & { AI?: AiBinding };

/** Секрет приймається лише в заголовку: в адресі він лишився б в історії браузера і в логах. */
function authorized(request: Request, env: Env): boolean {
  return Boolean(env.WEBHOOK_SECRET) && request.headers.get(SECRET_HEADER) === env.WEBHOOK_SECRET;
}

/** Короткий опис оновлення для логів: тип, чат, гілка, відправник, команда. Без тексту повідомлень. */
export function describeUpdate(u: Update): string {
  const kind = Object.keys(u).find((k) => k !== "update_id") ?? "?";
  const m = u.message ?? u.callback_query?.message;
  const from = u.message?.from ?? u.callback_query?.from ?? u.my_chat_member?.from;
  const chat = m?.chat ?? u.my_chat_member?.chat;
  const parts = [kind, `chat=${chat?.id ?? "-"}${chat && "is_forum" in chat && chat.is_forum ? "(теми)" : ""}`];
  if (m && "message_thread_id" in m) parts.push(`гілка=${m.is_topic_message ? m.message_thread_id : "-"}`);
  parts.push(`від=${from?.id ?? "-"}`);
  if (u.message?.sender_chat) parts.push(`від_імені_чату=${u.message.sender_chat.id}`);
  const text = u.message?.text;
  if (text?.startsWith("/")) parts.push(`команда=${text.split(/\s/)[0]}`);
  if (u.callback_query?.data) parts.push(`кнопка=${u.callback_query.data.split("|")[0]}`);
  if (u.my_chat_member) parts.push(`статус=${u.my_chat_member.old_chat_member.status}→${u.my_chat_member.new_chat_member.status}`);
  return parts.join(" ");
}

interface Inject {
  api?: Api;
  fetch?: typeof fetch;
  now?: () => Date;
}

function cronDeps(env: FullEnv, deadline: number, inject: Inject): Deps {
  return {
    env,
    api: inject.api ?? new Api(env.BOT_TOKEN),
    db: env.DB,
    sheet: { db: env.DB, sheetId: env.SHEET_ID, saKey: env.GOOGLE_SA_KEY, fetch: inject.fetch },
    deadline,
    now: inject.now,
  };
}

/** Дочитати статус K для записаних броней, які не встигли перевірити одразу. */
export async function runPendingVerifications(env: FullEnv, deadline: number, inject: Inject = {}): Promise<number> {
  const cards = await pendingVerifications(env.DB);
  if (!cards.length) return 0;
  const deps = cronDeps(env, deadline, inject);
  let done = 0;
  for (const card of cards) if ((await verifyCard(deps, card.id)) === "done") done++;
  return done;
}

/** Усе, що робить Cron кожні 5 хв: нагадування/зведення і дочитування статусів K. */
export async function runCron(env: FullEnv, inject: Inject = {}): Promise<{ reminders: RunResult; verified: number }> {
  const deadline = Date.now() + CRON_BUDGET_MS;
  // Нагадування — першими: вони чутливі до часу, а статус K може зачекати.
  const reminders = await runReminders(cronDeps(env, deadline, inject));
  const verified = await runPendingVerifications(env, deadline, inject);
  return { reminders, verified };
}

export default {
  async fetch(request: Request, env: FullEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!["/webhook", "/setup", "/status", "/run-check"].includes(url.pathname)) return new Response("Not found", { status: 404 });
    if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      // Читання таблиці після будь-якої зміни чекає її перерахунку (~17 с), тому Telegram відповідаємо
      // одразу, а оновлення обробляємо у фоні. Помилки — лише в лог: повтор того самого оновлення не допоможе.
      const update = (await request.json()) as Update;
      console.log("Оновлення", describeUpdate(update));
      const deadline = Date.now() + BACKGROUND_BUDGET_MS;
      ctx.waitUntil(
        (async () => {
          const bot = createBot(env, { deadline, ai: env.AI });
          if (!env.BOT_INFO) await bot.init();
          await bot.handleUpdate(update);
        })().catch((err) => console.error("Помилка обробки оновлення", err)),
      );
      return new Response("ok");
    }

    if (url.pathname === "/setup") {
      const api = new Api(env.BOT_TOKEN);
      await api.setWebhook(`${url.origin}/webhook`, { secret_token: env.WEBHOOK_SECRET, allowed_updates: ALLOWED_UPDATES });
      await api.setMyCommands([{ command: "start", description: "Прив'язати гілку / показати меню" }]);
      const me = await api.getMe();
      // Скопіюйте bot_info у BOT_INFO в wrangler.toml, щоб бот не викликав getMe на кожен запит.
      return Response.json({ ok: true, webhook: `${url.origin}/webhook`, bot_info: JSON.stringify(me) });
    }

    // Ручний запуск того самого, що робить Cron (без дублів — ті самі ключі).
    if (url.pathname === "/run-check") return Response.json(await runCron(env));

    // Стан: вебхук у Telegram, доступ до таблиці (ключ Google), прив'язка гілки, черга перевірок K.
    const [telegram, sheet, binding, pending] = await Promise.all([
      new Api(env.BOT_TOKEN)
        .getWebhookInfo()
        .then((info) => ({
          url: info.url,
          pending_update_count: info.pending_update_count,
          last_error_date: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
          last_error_message: info.last_error_message ?? null,
        }))
        .catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
      loadSettings({ db: env.DB, sheetId: env.SHEET_ID, saKey: env.GOOGLE_SA_KEY }, { fresh: true })
        .then((s) => ({ ok: true, pcs: s.pcList.length, stream: s.pcList.filter((p) => s.zones[p] === "Stream") }))
        .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) })),
      getBinding(env.DB),
      env.DB.prepare("SELECT count(*) AS n FROM cards WHERE verify_pending = 1").first<{ n: number }>(),
    ]);
    return Response.json({ telegram, sheet, binding, verify_pending: pending?.n ?? 0, bot_info_cached: Boolean(env.BOT_INFO) });
  },

  // Кожні 5 хв: нагадування за 30 хв, зведення в годину відкриття, дочитування статусів K.
  async scheduled(_controller: ScheduledController, env: FullEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCron(env)
        .then((r) => {
          if (r.reminders.sent || r.reminders.failed || r.verified) console.log("Cron:", JSON.stringify(r));
        })
        .catch((err) => console.error("Cron завершився помилкою", err)),
    );
  },
};
