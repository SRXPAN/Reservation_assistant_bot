// Підключення логіки до grammY: ізоляція DM клієнтів, закритий адмін-канал, єдина перевірка isAdmin.

import { Bot, type Context } from "grammy";
import type { Message, UserFromGetMe } from "grammy/types";
import type { AiBinding } from "./ai";
import { menuKeyboard } from "./card";
import { onClientCallback, onClientContact, onClientStart, onClientText, type ClientUser } from "./client_flow";
import { getBotUsername, getConfig, isAdmin, sheetUrl, type Env } from "./config";
import { auditText, onBookingText, onCallback, onMenu, onPromptReply, type Deps, type Who } from "./flow";
import { safeError } from "./log";
import { onAttendance } from "./reminders";
import { audit, getBinding, getClientSession, setBinding, type Binding } from "./store";

export interface BotOptions {
  /** До якого моменту (мс) треба закінчити обробку. */
  deadline: number;
  now?: () => Date;
  ai?: AiBinding;
  fetch?: typeof fetch;
}

/** Службовий акаунт, від імені якого Telegram показує повідомлення анонімних адміністраторів. */
const ANONYMOUS_ADMIN = 1087968824;

const who = (ctx: Context): Who => {
  const u = ctx.from!;
  return { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id) };
};

const clientUser = (ctx: Context): ClientUser => {
  const u = ctx.from!;
  return {
    id: u.id,
    first_name: u.first_name,
    last_name: u.last_name,
    username: u.username,
    displayName: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id),
  };
};

/** Гілка повідомлення: для тем — message_thread_id, для «General» і звичайних груп — null. */
const threadOf = (m: Pick<Message, "is_topic_message" | "message_thread_id"> | undefined): number | null =>
  m?.is_topic_message && m.message_thread_id ? m.message_thread_id : null;

const inBinding = (b: Binding | null, chatId: number | undefined, thread: number | null) =>
  !!b && b.chat_id === chatId && b.thread_id === thread;

export const MENU_TEXT = [
  "📌 <b>Бронювання ПК</b>",
  "Пишіть бронь одним повідомленням у цій гілці, напр.:",
  "• <code>пт 18 пк 12-17 з 19 до 2 Vova tg</code>",
  "• <code>21.11 ПК 18 16:00-19:00 Андрій +48 501 234 567</code>",
  "• <code>завтра пк 12,14,16 18:00–22:00 Олег insta</code>",
  "Бот покаже картку з перевіркою. У таблицю — лише після ✅.",
].join("\n");

export function createBot(env: Env, opts: BotOptions): Bot {
  const botInfo = env.BOT_INFO ? (JSON.parse(env.BOT_INFO) as UserFromGetMe) : undefined;
  const bot = new Bot(env.BOT_TOKEN, { botInfo });
  const config = getConfig(env);
  const deps: Deps = {
    env,
    api: bot.api,
    db: env.DB,
    sheet: { db: env.DB, sheetId: env.SHEET_ID, saKey: env.GOOGLE_SA_KEY, fetch: opts.fetch },
    ai: opts.ai,
    deadline: opts.deadline,
    now: opts.now,
  };
  const isOwner = (ctx: Context) => ctx.from?.id === config.ownerId;
  const menuMarkup = menuKeyboard(sheetUrl(env.SHEET_ID));

  /** Перенаправлення з публічної групи в приватні повідомлення бота без розкриття жодних броней. */
  async function replyDmRedirect(ctx: Context, thread: number | null) {
    const username = getBotUsername(env, ctx.me?.username);
    const text = "🔒 Бронювання ПК та перегляд вільних місць доступні лише в особистих повідомленнях бота.";
    const reply_markup = username
      ? { inline_keyboard: [[{ text: "💬 Перейти в особисті повідомлення", url: `https://t.me/${username}?start=book` }]] }
      : undefined;
    await ctx.reply(text, {
      message_thread_id: thread ?? undefined,
      reply_markup,
    });
  }

  function mentionsBot(text: string, ctx: Context): boolean {
    const username = getBotUsername(env, ctx.me?.username);
    if (!username) return false;
    return text.toLowerCase().includes(`@${username.toLowerCase()}`);
  }

  /** Показати меню: оновити вже закріплене, а якщо його немає — надіслати нове і закріпити. */
  async function showMenu(chatId: number, thread: number | null, binding: Binding) {
    if (binding.menu_message_id) {
      const updated = await bot.api
        .editMessageText(chatId, binding.menu_message_id, MENU_TEXT, { parse_mode: "HTML", reply_markup: menuMarkup, link_preview_options: { is_disabled: true } })
        .then(() => true)
        .catch((err) => String(err).includes("message is not modified"));
      if (updated) {
        await bot.api.pinChatMessage(chatId, binding.menu_message_id, { disable_notification: true }).catch(() => {});
        return;
      }
    }
    const menu = await bot.api.sendMessage(chatId, MENU_TEXT, {
      parse_mode: "HTML",
      message_thread_id: thread ?? undefined,
      reply_markup: menuMarkup,
      link_preview_options: { is_disabled: true },
    });
    await bot.api.pinChatMessage(chatId, menu.message_id, { disable_notification: true }).catch((err) => {
      console.warn("Не вдалося закріпити меню (потрібне право «Закріплювати повідомлення»)", safeError(err));
    });
    await setBinding(env.DB, { ...binding, menu_message_id: menu.message_id });
  }

  // /start: у ЛС — клієнтське меню; у групі — прив'язка гілки (лише власник) або редирект у DM.
  bot.command("start", async (ctx) => {
    const chat = ctx.chat;
    if (chat.type === "private") {
      if (ctx.from?.is_bot) return;
      await onClientStart(deps, clientUser(ctx), chat.type);
      return;
    }
    const thread = threadOf(ctx.msg);
    const binding = await getBinding(env.DB);
    if (!isOwner(ctx)) {
      const anonymous = ctx.from?.id === ANONYMOUS_ADMIN || ctx.msg.sender_chat?.id === chat.id;
      if (!binding && anonymous) {
        await ctx.reply(
          "Ви пишете анонімно (від імені групи), тож я не можу перевірити, що це власник. Вимкніть «Залишатися анонімним» у своїх правах адміністратора або напишіть /start з особистого акаунта власника.",
          { message_thread_id: thread ?? undefined },
        );
        return;
      }
      await replyDmRedirect(ctx, thread);
      return;
    }
    if (inBinding(binding, chat.id, thread)) {
      await showMenu(chat.id, thread, binding!);
      return;
    }
    await ctx.reply(binding ? "Перенести роботу з бронюваннями в цю гілку? Стара прив'язка перестане діяти." : "Прив'язати цю гілку для бронювань?", {
      message_thread_id: thread ?? undefined,
      reply_markup: { inline_keyboard: [[{ text: "Так", callback_data: `bind|${thread ?? 0}` }, { text: "Ні", callback_data: "nobind|" }]] },
    });
  });

  // /admin: повне адмін-меню в DM або в прив'язаній адмін-гілці (лише для isAdmin).
  bot.command("admin", async (ctx) => {
    const thread = threadOf(ctx.msg);
    if (!isAdmin(ctx.from?.id, env)) {
      if (ctx.chat.type === "private") {
        await ctx.reply("⛔ Команда доступна лише адміністраторам.");
      } else {
        await replyDmRedirect(ctx, thread);
      }
      return;
    }
    if (ctx.chat.type === "private") {
      await ctx.reply(MENU_TEXT, {
        parse_mode: "HTML",
        reply_markup: menuMarkup,
        link_preview_options: { is_disabled: true },
      });
      return;
    }
    const binding = await getBinding(env.DB);
    if (inBinding(binding, ctx.chat.id, thread)) {
      await showMenu(ctx.chat.id, thread, binding!);
    } else {
      await replyDmRedirect(ctx, thread);
    }
  });

  // /log: останні дії (лише адміністратор; у прив'язаній гілці або в особистих).
  bot.command("log", async (ctx) => {
    const thread = threadOf(ctx.msg);
    if (!isAdmin(ctx.from?.id, env)) {
      if (ctx.chat.type === "private") {
        await ctx.reply("⛔ Команда доступна лише адміністраторам.");
      }
      return;
    }
    const binding = await getBinding(env.DB);
    if (ctx.chat.type !== "private" && !inBinding(binding, ctx.chat.id, thread)) return;
    await ctx.reply(await auditText(deps), { parse_mode: "HTML", message_thread_id: thread ?? undefined });
  });

  bot.callbackQuery(/^(bind|nobind)\|/, async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.answerCallbackQuery({ text: "Прив'язати гілку може лише власник" });
      return;
    }
    const msg = ctx.callbackQuery.message;
    if (!msg) return;
    if (ctx.callbackQuery.data.startsWith("nobind")) {
      await ctx.answerCallbackQuery();
      await ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      return;
    }
    const thread = threadOf(msg as Message);
    const binding: Binding = { chat_id: msg.chat.id, thread_id: thread };
    await setBinding(env.DB, binding);
    await ctx.answerCallbackQuery({ text: "Гілку прив'язано" });
    await ctx.api.editMessageText(msg.chat.id, msg.message_id, "✅ Гілку прив'язано. Пишіть броні тут.").catch(() => {});
    await showMenu(msg.chat.id, thread, binding);
    await audit(env.DB, { user_id: ctx.from.id, user_name: who(ctx).name, action: "bind", details: binding });
  });

  // Кнопки: у ЛС (c:*) — клієнтський режим; адмінські кнопки (m:*, a:*, картки) — тільки для isAdmin у DM або прив'язаному адмін-чаті.
  bot.on("callback_query:data", async (ctx) => {
    const msg = ctx.callbackQuery.message;
    const data = ctx.callbackQuery.data;
    let answered = false;
    const answer = async (r: { toast?: string; alert?: boolean }) => {
      if (answered) return;
      answered = true;
      await ctx.answerCallbackQuery({ text: r.toast, show_alert: r.alert }).catch(() => {});
    };

    if (!msg) {
      await answer({});
      return;
    }

    if (data.startsWith("c:")) {
      if (msg.chat.type !== "private") {
        await answer({ toast: "Доступно лише в особистих повідомленнях." });
        return;
      }
      await onClientCallback(deps, { data, chat_id: msg.chat.id, message_id: msg.message_id, chat_type: msg.chat.type }, clientUser(ctx), answer);
      if (!answered) await ctx.answerCallbackQuery().catch(() => {});
      return;
    }

    const thread = threadOf(msg as Message);
    if (msg.chat.type !== "private") {
      const binding = await getBinding(env.DB);
      if (!inBinding(binding, msg.chat.id, thread)) {
        await answer({ toast: "Недоступно в цьому чаті." });
        return;
      }
    }

    if (!isAdmin(ctx.from?.id, env)) {
      await answer({ toast: "Немає доступу." });
      return;
    }

    if (data.startsWith("m:")) await onMenu(deps, data.slice(2), { chat_id: msg.chat.id, thread_id: thread }, who(ctx), answer);
    else if (data.startsWith("a:")) {
      const [act, id] = data.slice(2).split("|");
      await onAttendance(deps, { came: act === "y", reminderId: Number(id), chat_id: msg.chat.id, message_id: msg.message_id }, who(ctx), answer);
    } else await onCallback(deps, { data, chat_id: msg.chat.id, message_id: msg.message_id }, who(ctx), answer);
    if (!answered) await ctx.answerCallbackQuery().catch(() => {});
  });

  // Контакт (номер телефону) дозволено виключно у ЛС клієнта.
  bot.on("message:contact", async (ctx) => {
    if (ctx.chat.type !== "private" || ctx.from?.is_bot) return;
    await onClientContact(
      deps,
      { chat_id: ctx.chat.id, message_id: ctx.msg.message_id, phone_number: ctx.msg.contact.phone_number, chat_type: ctx.chat.type },
      clientUser(ctx),
    );
  });

  // Текст: у ЛС — клієнтський майстер (і адмін-парсер для isAdmin); у публічних групах — редирект у DM.
  bot.on("message:text", async (ctx) => {
    if (ctx.from.is_bot) return;
    const text = ctx.msg.text;

    if (ctx.chat.type === "private") {
      if (text.startsWith("/")) return;
      if (isAdmin(ctx.from.id, env)) {
        const reply = ctx.msg.reply_to_message;
        if (reply && reply.from?.id === ctx.me.id) {
          const handled = await onPromptReply(
            deps,
            { chat_id: ctx.chat.id, thread_id: null, message_id: ctx.msg.message_id, reply_to: reply.message_id, text },
            who(ctx),
          );
          if (handled) return;
        }
        const session = await getClientSession(env.DB, ctx.from.id);
        if (session && ["name_input", "phone_input"].includes(session.step)) {
          await onClientText(deps, { chat_id: ctx.chat.id, message_id: ctx.msg.message_id, text, chat_type: ctx.chat.type }, clientUser(ctx));
          return;
        }
        if (await onBookingText(deps, { chat_id: ctx.chat.id, thread_id: null, message_id: ctx.msg.message_id, text }, who(ctx))) {
          return;
        }
      }
      await onClientText(deps, { chat_id: ctx.chat.id, message_id: ctx.msg.message_id, text, chat_type: ctx.chat.type }, clientUser(ctx));
      return;
    }

    const binding = await getBinding(env.DB);
    const thread = threadOf(ctx.msg);
    if (!inBinding(binding, ctx.chat.id, thread)) {
      if (text.startsWith("/") || mentionsBot(text, ctx)) {
        await replyDmRedirect(ctx, thread);
      }
      return;
    }

    if (!isAdmin(ctx.from.id, env)) {
      if (text.startsWith("/") || mentionsBot(text, ctx)) {
        await replyDmRedirect(ctx, thread);
      }
      return;
    }

    const reply = ctx.msg.reply_to_message;
    if (reply && reply.from?.id === ctx.me.id) {
      const handled = await onPromptReply(
        deps,
        { chat_id: ctx.chat.id, thread_id: thread, message_id: ctx.msg.message_id, reply_to: reply.message_id, text },
        who(ctx),
      );
      if (handled) return;
    }
    if (text.startsWith("/")) return;
    await onBookingText(deps, { chat_id: ctx.chat.id, thread_id: thread, message_id: ctx.msg.message_id, text }, who(ctx));
  });

  bot.catch((err) => {
    console.error("Помилка в обробнику", safeError(err));
  });

  return bot;
}
