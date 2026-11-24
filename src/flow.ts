// Логіка карток броні і меню: повідомлення → картка → ✅ / ✏️ / ❌ / 🗑, перевірка K, «Бронь кнопками»,
// списки «Сьогодні / Завтра / Вільні зараз / Пошук», журнал.
// Telegram тут — лише через Api (без Context), щоб ту саму логіку викликав і Cron.

import type { Api } from "grammy";
import { aiParse, mergeAi, type AiBinding } from "./ai";
import { isOkStatus, newBookingId, type SheetBooking } from "./bookings";
import {
  FIELD_PROMPTS,
  WIZARD_HINT,
  WIZARD_NEXT,
  cancelOnlyKeyboard,
  checkBlock,
  confirmKeyboard,
  dateKeyboard,
  deleteKeyboard,
  draftKeyboard,
  esc,
  fieldsBlock,
  fieldsKeyboard,
  missingKeyboard,
  retryKeyboard,
  savedKeyboard,
  type CardSettings,
  type Keyboard,
} from "./card";
import { botVerdictOk, evaluate, hasWarnings, toNewBooking, type Check } from "./check";
import { isAdmin, sheetUrl, type Env } from "./config";
import { LockBusyError } from "./db";
import { safeError } from "./log";
import { emptyDraft, normalizeContact, parseBooking, parseDateInput, parsePcsInput, parseTimeInput, type Draft } from "./parse";
import {
  BookingMissingError,
  SheetFullError,
  clearBooking,
  loadSettings,
  placeBooking,
  readSnapshot,
  replaceBooking,
  verifyBooking,
  type SheetCtx,
  type Snapshot,
} from "./sheet";
import { audit, createCard, createPrompt, draftOf, getCard, recentAudit, takePrompt, updateCard, type CardRow, type CardState } from "./store";
import { formatHHMM, nowAbs, serialToDate, zonedNow } from "./time";
import { businessDay, dayView, freeNowView, searchView, toEntries } from "./views";

export interface Deps {
  env: Env;
  api: Api;
  db: D1Database;
  sheet: SheetCtx;
  ai?: AiBinding;
  /** Момент (мс), до якого треба встигнути (бюджет waitUntil). */
  deadline: number;
  now?: () => Date;
}

export interface Who {
  id: number;
  name: string;
}

export interface Place {
  chat_id: number;
  thread_id: number | null;
}

const now = (d: Deps) => (d.now ? d.now() : new Date());
const tz = (d: Deps) => d.env.TZ || "Europe/Warsaw";
const nowMin = (d: Deps) => nowAbs(tz(d), now(d));

function stampOf(d: Deps, date: Date): string {
  const z = zonedNow(tz(d), date);
  const { d: day, m } = serialToDate(z.serial);
  return `${String(day).padStart(2, "0")}.${String(m).padStart(2, "0")} ${formatHHMM(z.minutes)}`;
}
const stamp = (d: Deps) => stampOf(d, now(d));

const mention = (who: Who) => `<a href="tg://user?id=${who.id}">${esc(who.name)}</a>`;

/* ───────────── текст картки ───────────── */

function header(card: CardRow): string {
  switch (card.state) {
    case "editing":
      return "✏️ <b>Зміна броні</b> (ще не збережено)";
    case "saved":
      return "📌 <b>Бронь</b>";
    case "deleting":
    case "deleted":
      return "🗑 <b>Бронь скасовано</b>";
    case "cancelled":
      return "❌ <b>Відмінено</b>";
    case "saving":
      return card.saved_data ? "✏️ <b>Зміна броні</b>" : "📝 <b>Нова бронь</b>";
    default:
      return "📝 <b>Нова бронь</b>";
  }
}

function savedLine(card: CardRow): string {
  const rows = card.rows ? (JSON.parse(card.rows) as number[]) : [];
  const where = rows.length ? ` · рядок ${rows.join(", ")}` : "";
  const k = card.k_status ? esc(card.k_status) : "⏳ перевіряю…";
  let line = `✅ Записано${where} · статус таблиці: ${k} · записав ${esc(card.saved_by_name ?? "")}`;
  if (card.k_status && !card.verify_pending && card.bot_ok !== null && !card.k_status.startsWith("❗")) {
    const tableOk = card.k_status.split(" | ").every(isOkStatus);
    if (tableOk !== (card.bot_ok === 1)) {
      line += `\n❗ Перевірка бота (${card.bot_ok ? "все гаразд" : "є проблема"}) і таблиці розходяться — гляньте таблицю`;
    }
  }
  return line;
}

export function renderCard(card: CardRow): string {
  const parts = [header(card)];
  const body = card.state === "saved" || card.state === "deleting" || card.state === "deleted" ? card.saved_body ?? card.body : card.body;
  parts.push(body || "⏳ Перевіряю таблицю…");
  const footer: string[] = [];
  if (card.state === "saving") footer.push("⏳ Записую в таблицю…");
  if (card.state === "saved" || card.state === "editing") footer.push(savedLine(card));
  if (card.state === "deleting") footer.push("⏳ Скасовую…");
  if (card.state === "deleted") footer.push(`🗑 Скасовано · ${esc(card.closed_by_name ?? "")}, ${card.closed_at ?? ""}`);
  if (card.state === "cancelled") footer.push(`Відмінив ${esc(card.closed_by_name ?? "")}, ${card.closed_at ?? ""}`);
  if (card.error) footer.push(`❗ ${esc(card.error)}`);
  return parts.join("\n") + (footer.length ? "\n\n" + footer.join("\n") : "");
}

const NO_BUTTONS: Keyboard = { inline_keyboard: [] };

function keyboardFor(card: CardRow): Keyboard {
  if (["saving", "deleting", "deleted", "cancelled"].includes(card.state)) return NO_BUTTONS;
  return card.kb ? (JSON.parse(card.kb) as Keyboard) : NO_BUTTONS;
}

const notModified = (err: unknown) => String(err).includes("message is not modified");

async function showCard(d: Deps, card: CardRow, kb: Keyboard = keyboardFor(card)) {
  if (!card.message_id) return;
  await d.api
    .editMessageText(card.chat_id, card.message_id, renderCard(card), {
      parse_mode: "HTML",
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    })
    .catch((err) => {
      if (!notModified(err)) throw err;
    });
}

async function setKeyboard(d: Deps, card: CardRow, kb: Keyboard) {
  if (!card.message_id) return;
  await d.api.editMessageReplyMarkup(card.chat_id, card.message_id, { reply_markup: kb }).catch((err) => {
    if (!notModified(err)) throw err;
  });
}

const reload = async (d: Deps, id: string): Promise<CardRow> => (await getCard(d.db, id))!;

/* ───────────── перевірка ───────────── */

const bodyOf = (draft: Draft, check: Check, s: CardSettings) => [...fieldsBlock(draft, s), "", ...checkBlock(draft, check, s)].join("\n");

interface Evaluated {
  check: Check;
  body: string;
  settings: CardSettings;
}

function evaluateIn(d: Deps, snap: Snapshot, draft: Draft, ignoreId?: string): Evaluated {
  const check = evaluate(draft, snap.bookings, snap.settings.schedule, nowMin(d), ignoreId);
  return { check, body: bodyOf(draft, check, snap.settings), settings: snap.settings };
}

const evaluateDraft = async (d: Deps, draft: Draft, ignoreId?: string) => evaluateIn(d, await readSnapshot(d.sheet), draft, ignoreId);

/** Записана бронь у тому вигляді, як вона зараз стоїть у таблиці (пошук за ID). */
export function draftFromSheet(bookings: SheetBooking[], id: string, pcList: number[]): Draft | null {
  const raw = bookings.find((b) => b.botId === id && b.date !== null && b.from !== null && b.to !== null);
  const entry = toEntries(bookings, pcList).find((e) => e.id === id);
  if (!raw || !entry) return null;
  return { ...emptyDraft(), date: raw.date, pcs: entry.pcs, from: raw.from, to: raw.to, name: raw.name, contact: raw.contact, note: raw.note };
}

const sameBooking = (a: Draft, b: Draft) =>
  a.date === b.date && a.from === b.from && a.to === b.to && a.pcs.join() === b.pcs.join() && a.name === b.name && a.contact === b.contact && a.note === b.note;

/** Попросити ввести поле (ForceReply у тій самій гілці, лише для того, хто натиснув). */
async function askField(d: Deps, place: Place, field: string, who: Who, cardId: string | null, replyTo: number | null, error?: string) {
  const key = field.startsWith("w:") ? field.slice(2) : field;
  const meta = FIELD_PROMPTS[key]!;
  const text = error ? `${mention(who)}, ${esc(error)}` : `${mention(who)}, напишіть ${meta.ask} у відповідь на це повідомлення:`;
  const sent = await d.api.sendMessage(place.chat_id, text, {
    parse_mode: "HTML",
    message_thread_id: place.thread_id ?? undefined,
    reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
    reply_markup: { force_reply: true, selective: true, input_field_placeholder: meta.placeholder },
  });
  await createPrompt(d.db, { chat_id: place.chat_id, message_id: sent.message_id, card_id: cardId, field, user_id: who.id });
}

/* ───────────── нове повідомлення ───────────── */

const CORE = ["дата", "ПК", "час початку", "час кінця"];

/** Повідомлення в гілці. Повертає true, якщо це була бронь (показано картку). */
export async function onBookingText(
  d: Deps,
  msg: { chat_id: number; thread_id: number | null; message_id: number; text: string },
  who: Who,
): Promise<boolean> {
  if (!isAdmin(who.id, d.env)) return false;
  const settings = await loadSettings(d.sheet);
  const today = zonedNow(tz(d), now(d)).serial;
  const parsed = parseBooking(msg.text, { today, pcList: settings.pcList });
  if (!parsed.signals) return false;

  let draft = parsed.draft;
  let aiUsed = false;
  if (parsed.missing.some((m) => CORE.includes(m))) {
    const ai = await aiParse(d.ai, d.db, msg.text, today, settings.pcList);
    if (ai) ({ draft, used: aiUsed } = mergeAi(draft, ai));
  }

  const id = newBookingId(now(d).getTime());
  const preview = ["📝 <b>Нова бронь</b>", ...fieldsBlock(draft, settings), "", "⏳ Перевіряю таблицю…"].join("\n");
  const sent = await d.api.sendMessage(msg.chat_id, preview, {
    parse_mode: "HTML",
    message_thread_id: msg.thread_id ?? undefined,
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
    link_preview_options: { is_disabled: true },
  });
  await createCard(d.db, { id, chat_id: msg.chat_id, thread_id: msg.thread_id, source_message_id: msg.message_id, data: draft, body: "", user_id: who.id, user_name: who.name });
  await updateCard(d.db, id, { message_id: sent.message_id });
  await audit(d.db, { user_id: who.id, user_name: who.name, action: "card", card_id: id, details: { text: msg.text, ai: aiUsed, missing: parsed.missing } });
  await recheckDraft(d, id, draft, settings);
  return true;
}

/** Перевірити чернетку по таблиці й показати кнопки. Таблиця не відповіла — помилка і [🔄 Перевірити ще раз]. */
async function recheckDraft(d: Deps, id: string, draft: Draft, settings: CardSettings) {
  try {
    const ev = await evaluateDraft(d, draft);
    await updateCard(d.db, id, { body: ev.body, kb: JSON.stringify(draftKeyboard(id, ev.check, false)), bot_ok: botVerdictOk(ev.check) ? 1 : 0, error: null });
  } catch (err) {
    console.error("Перевірка чернетки", id, safeError(err));
    await updateCard(d.db, id, {
      body: fieldsBlock(draft, settings).join("\n"),
      kb: JSON.stringify(retryKeyboard(id)),
      error: `Не вдалося прочитати таблицю (${err instanceof Error ? err.message : String(err)}). Спробуйте ще раз.`,
    });
  }
  await showCard(d, await reload(d, id));
}

/** Будь-яка непередбачена помилка під час дії з карткою: картка не «зависає», а показує помилку. */
async function reportCardError(d: Deps, id: string | null | undefined, err: unknown) {
  console.error("Помилка дії з карткою", id, safeError(err));
  if (!id) return;
  const card = await getCard(d.db, id);
  if (!card) return;
  const state: CardState = card.state === "saving" ? (card.saved_data ? "editing" : "draft") : card.state === "deleting" ? "saved" : card.state;
  await updateCard(d.db, id, { state, error: `Не вдалося: ${err instanceof Error ? err.message : String(err)}. Спробуйте ще раз.` });
  await showCard(d, await reload(d, id)).catch(() => {});
}

/* ───────────── кнопки картки ───────────── */

export interface CallbackResult {
  /** Текст спливаючої підказки (answerCallbackQuery). */
  toast?: string;
  alert?: boolean;
}
type Answer = (r: CallbackResult) => Promise<void>;

/** Обробка натискання на картці. `answer` викликається якомога раніше — до повільних запитів до таблиці. */
export async function onCallback(d: Deps, q: { data: string; chat_id: number; message_id: number }, who: Who, answer: Answer): Promise<void> {
  if (!isAdmin(who.id, d.env)) {
    await answer({ toast: "Немає доступу." });
    return;
  }
  try {
    await handleCallback(d, q, who, answer);
  } catch (err) {
    await answer({});
    await reportCardError(d, q.data.split("|")[1], err);
  }
}

async function handleCallback(d: Deps, q: { data: string; chat_id: number; message_id: number }, who: Who, answer: Answer): Promise<void> {
  const [act, id] = q.data.split("|") as [string, string];
  const card = id ? await getCard(d.db, id) : null;
  if (!card || card.chat_id !== q.chat_id || card.message_id !== q.message_id) {
    await answer({ toast: "Картка застаріла" });
    return;
  }
  const state = card.state;
  const can = (...states: CardState[]) => states.includes(state);
  const place: Place = { chat_id: card.chat_id, thread_id: card.thread_id };

  switch (act) {
    case "b": // назад до головних кнопок
      await answer({});
      if (can("draft", "editing", "saved")) await setKeyboard(d, card, keyboardFor(card));
      return;

    case "e": // вибір поля для зміни
      if (!can("draft", "editing", "saved")) return answer({ toast: "Цю картку вже не можна змінити" });
      await answer({});
      if (state === "saved") return startEditingSaved(d, card, who);
      await setKeyboard(d, card, fieldsKeyboard(id));
      return;

    case "k": // таблиця не відповідала — перевірити ще раз
      if (!can("draft")) return answer({ toast: "Картку вже оброблено" });
      await answer({ toast: "Перевіряю…" });
      await recheckDraft(d, id, draftOf(card), await loadSettings(d.sheet));
      return;

    case "w": // підтвердження «попри попередження»
      if (!can("draft", "editing")) return answer({ toast: "Картка вже не чернетка" });
      await answer({});
      await setKeyboard(d, card, confirmKeyboard(id));
      return;

    case "d":
      if (!can("saved")) return answer({ toast: "Бронь не записана" });
      await answer({});
      await setKeyboard(d, card, deleteKeyboard(id));
      return;

    case "c": // відміна чернетки
      if (!(await updateCard(d.db, id, { state: "cancelled", closed_by_name: who.name, closed_at: stamp(d) }, ["draft"]))) {
        return answer({ toast: "Картку вже оброблено" });
      }
      await answer({ toast: "Відмінено" });
      await showCard(d, await reload(d, id));
      await audit(d.db, { user_id: who.id, user_name: who.name, action: "cancel", card_id: id });
      return;

    case "u": // відмовитись від змін записаної броні
      if (!(await updateCard(d.db, id, { state: "saved", data: card.saved_data!, body: card.saved_body ?? "", kb: JSON.stringify(savedKeyboard(id, sheetUrl(d.env.SHEET_ID))), error: null }, ["editing"]))) {
        return answer({ toast: "Картку вже оброблено" });
      }
      await answer({ toast: "Зміни не збережено" });
      await showCard(d, await reload(d, id));
      return;

    case "R": // броні в таблиці немає → зробити з картки нову чернетку з тим самим ID
      if (!can("saved", "editing")) return answer({ toast: "Картку вже оброблено" });
      await answer({});
      return recreateAsDraft(d, card, who);

    case "X": // броні в таблиці немає → закрити картку
      if (!(await updateCard(d.db, id, { state: "deleted", closed_by_name: who.name, closed_at: stamp(d), verify_pending: 0, error: "Картку закрито: броні в таблиці немає" }, ["saved", "editing"]))) {
        return answer({ toast: "Картку вже оброблено" });
      }
      await answer({ toast: "Картку закрито" });
      await showCard(d, await reload(d, id));
      await audit(d.db, { user_id: who.id, user_name: who.name, action: "close_missing", card_id: id });
      return;

    case "s":
    case "f":
      return save(d, card, who, act === "f", answer);

    case "D":
      return remove(d, card, who, answer);
  }

  if (act.startsWith("nd:")) return wizardDate(d, card, act.slice(3), who, answer);

  if (act.startsWith("p:")) {
    const field = act.slice(2);
    if (!FIELD_PROMPTS[field] || !can("draft", "editing", "saved")) return answer({ toast: "Цю картку вже не можна змінити" });
    await answer({});
    await askField(d, place, field, who, id, card.message_id);
    return;
  }
  await answer({});
}

/**
 * ✏️ на записаній картці: спершу читаємо бронь із таблиці за ID — її могли змінити або видалити вручну.
 */
async function startEditingSaved(d: Deps, card: CardRow, who: Who) {
  const id = card.id;
  const snap = await readSnapshot(d.sheet);
  const current = draftFromSheet(snap.bookings, id, snap.settings.pcList);
  if (!current) {
    await updateCard(d.db, id, { error: new BookingMissingError().message, kb: JSON.stringify(missingKeyboard(id)) }, ["saved"]);
    await showCard(d, await reload(d, id));
    await audit(d.db, { user_id: who.id, user_name: who.name, action: "missing", card_id: id, details: "edit" });
    return;
  }
  const saved = JSON.parse(card.saved_data!) as Draft;
  const changed = !sameBooking(current, saved);
  const patch: Parameters<typeof updateCard>[2] = {};
  if (changed) {
    // Таблиця — головне джерело: беремо її дані як «записані».
    const fresh = evaluateIn(d, snap, current, id);
    patch.saved_data = JSON.stringify(current);
    patch.saved_body = fresh.body;
    current.hints = ["У таблиці бронь змінили вручну — показую актуальні дані"];
    await audit(d.db, { user_id: who.id, user_name: who.name, action: "changed_in_sheet", card_id: id, details: { was: toNewBooking(saved), now: toNewBooking(current) } });
  }
  const ev = evaluateIn(d, snap, current, id);
  await updateCard(
    d.db,
    id,
    { ...patch, state: "editing", data: JSON.stringify(current), body: ev.body, kb: JSON.stringify(draftKeyboard(id, ev.check, true)), bot_ok: botVerdictOk(ev.check) ? 1 : 0, error: null },
    ["saved"],
  );
  await showCard(d, await reload(d, id), fieldsKeyboard(id));
}

/** Броні в таблиці немає: картка стає новою чернеткою з тими самими даними і тим самим ID. */
async function recreateAsDraft(d: Deps, card: CardRow, who: Who) {
  const id = card.id;
  const draft = draftOf(card);
  draft.hints = [];
  const ev = await evaluateDraft(d, draft);
  const ok = await updateCard(
    d.db,
    id,
    {
      state: "draft",
      saved_data: null,
      saved_body: null,
      rows: null,
      k_status: null,
      verify_pending: 0,
      body: ev.body,
      kb: JSON.stringify(draftKeyboard(id, ev.check, false)),
      bot_ok: botVerdictOk(ev.check) ? 1 : 0,
      error: null,
    },
    [card.state],
  );
  if (!ok) return;
  await showCard(d, await reload(d, id));
  await audit(d.db, { user_id: who.id, user_name: who.name, action: "recreate", card_id: id });
}

async function save(d: Deps, card: CardRow, who: Who, force: boolean, answer: Answer) {
  const id = card.id;
  const from = card.state;
  if (from !== "draft" && from !== "editing") return answer({ toast: "Картку вже оброблено" });
  if (!(await updateCard(d.db, id, { state: "saving", error: null }, [from]))) return answer({ toast: "Уже записується" });
  await answer({ toast: "Записую…" });
  await showCard(d, await reload(d, id));

  const draft = draftOf(card);
  const updating = from === "editing";
  try {
    // Таблиця могла змінитися, поки картка висіла, — перевіряємо заново.
    const ev = await evaluateDraft(d, draft, updating ? id : undefined);
    const kb = JSON.stringify(draftKeyboard(id, ev.check, updating));
    if (ev.check.missing.length || (!force && hasWarnings(ev.check))) {
      await updateCard(d.db, id, { state: from, body: ev.body, kb, bot_ok: botVerdictOk(ev.check) ? 1 : 0, error: "Таблиця змінилась — перевірте ще раз" });
      await showCard(d, await reload(d, id));
      return;
    }
    const booking = toNewBooking(draft);
    const rows = updating ? await replaceBooking(d.sheet, booking, id, ev.settings.pcList) : await placeBooking(d.sheet, booking, id, ev.settings.pcList);
    await updateCard(d.db, id, {
      state: "saved",
      rows: JSON.stringify(rows),
      body: ev.body,
      saved_body: ev.body,
      saved_data: JSON.stringify({ ...draft, hints: [] }),
      kb: JSON.stringify(savedKeyboard(id, sheetUrl(d.env.SHEET_ID))),
      bot_ok: botVerdictOk(ev.check) ? 1 : 0,
      k_status: null,
      verify_pending: 1,
      saved_by_name: who.name,
      saved_at: stamp(d),
    });
    await showCard(d, await reload(d, id));
    await audit(d.db, {
      user_id: who.id,
      user_name: who.name,
      action: updating ? "update" : "save",
      card_id: id,
      details: { rows, force, booking, warnings: hasWarnings(ev.check) },
    });
    await verifyCard(d, id);
  } catch (err) {
    if (err instanceof BookingMissingError) {
      await updateCard(d.db, id, { state: from, error: err.message, kb: JSON.stringify(missingKeyboard(id)) });
      await showCard(d, await reload(d, id));
      await audit(d.db, { user_id: who.id, user_name: who.name, action: "missing", card_id: id, details: "save" });
      return;
    }
    const reason =
      err instanceof LockBusyError || err instanceof SheetFullError ? err.message : `Не вдалося записати: ${err instanceof Error ? err.message : String(err)}`;
    console.error("Запис броні", id, safeError(err));
    await updateCard(d.db, id, { state: from, error: reason });
    await showCard(d, await reload(d, id));
    await audit(d.db, { user_id: who.id, user_name: who.name, action: "save_error", card_id: id, details: reason });
  }
}

async function remove(d: Deps, card: CardRow, who: Who, answer: Answer) {
  const id = card.id;
  if (!(await updateCard(d.db, id, { state: "deleting", error: null }, ["saved"]))) return answer({ toast: "Бронь не записана або вже скасована" });
  await answer({ toast: "Скасовую…" });
  await showCard(d, await reload(d, id));
  try {
    const rows = await clearBooking(d.sheet, id);
    await updateCard(d.db, id, {
      state: "deleted",
      closed_by_name: who.name,
      closed_at: stamp(d),
      verify_pending: 0,
      error: rows.length ? null : "У таблиці цієї броні вже не було — рядок видалили вручну",
    });
    await showCard(d, await reload(d, id));
    await audit(d.db, { user_id: who.id, user_name: who.name, action: rows.length ? "delete" : "delete_missing", card_id: id, details: { rows } });
  } catch (err) {
    console.error("Скасування броні", id, safeError(err));
    await updateCard(d.db, id, { state: "saved", error: `Не вдалося скасувати: ${err instanceof Error ? err.message : String(err)}` });
    await showCard(d, await reload(d, id));
  }
}

/* ───────────── перечитування K ───────────── */

/**
 * Перечитати бронь і показати статус K. Читання після запису чекає перерахунку таблиці (~17 с),
 * тож якщо до дедлайну не встигаємо — лишаємо verify_pending, і це доробить Cron.
 */
export async function verifyCard(d: Deps, id: string): Promise<"done" | "later" | "skip"> {
  const card = await getCard(d.db, id);
  if (!card || !card.verify_pending || !["saved", "editing"].includes(card.state) || !card.rows) return "skip";
  const budget = d.deadline - Date.now() - 1_500;
  if (budget < 3_000) return "later";
  let result: { rows: number[]; statuses: string[] } | null;
  try {
    result = await Promise.race([
      verifyBooking(d.sheet, id, (JSON.parse(card.rows) as number[]).length),
      new Promise<null>((r) => setTimeout(() => r(null), budget)),
    ]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await updateCard(d.db, id, { k_status: `❗ ${reason}`, verify_pending: 0 });
    await showCard(d, await reload(d, id));
    await audit(d.db, { action: "verify_error", card_id: id, details: reason });
    return "done";
  }
  if (result === null) return "later";
  const k = result.statuses.join(" | ");
  if (!(await updateCard(d.db, id, { k_status: k, verify_pending: 0, rows: JSON.stringify(result.rows) }, ["saved", "editing"]))) return "skip";
  const tableOk = result.statuses.every(isOkStatus);
  if (card.bot_ok !== null && tableOk !== (card.bot_ok === 1)) {
    console.warn(`Розбіжність перевірки ${id}: бот ${card.bot_ok ? "OK" : "проблема"}, таблиця «${k}»`);
    await audit(d.db, { action: "verify_mismatch", card_id: id, details: { bot_ok: card.bot_ok, k } });
  }
  await showCard(d, await reload(d, id));
  return "done";
}

/* ───────────── «Бронь кнопками» ───────────── */

async function wizardDate(d: Deps, card: CardRow, value: string, who: Who, answer: Answer) {
  if (card.state !== "draft") return answer({ toast: "Картку вже оброблено" });
  await answer({});
  const place: Place = { chat_id: card.chat_id, thread_id: card.thread_id };
  if (value === "x") return askField(d, place, "w:date", who, card.id, card.message_id);
  const draft = draftOf(card);
  draft.date = Number(value);
  await wizardStep(d, card, draft, "pcs", who);
}

/** Показати в картці, що вже введено, і попросити наступне поле (або завершити — звичайна перевірка). */
async function wizardStep(d: Deps, card: CardRow, draft: Draft, next: string | null, who: Who) {
  if (next === null) return finishDraft(d, card, draft, who);
  const settings = await loadSettings(d.sheet);
  const body = [...fieldsBlock(draft, settings), "", WIZARD_HINT[next]!].join("\n");
  await updateCard(d.db, card.id, { data: JSON.stringify(draft), body, kb: JSON.stringify(cancelOnlyKeyboard(card.id)) }, ["draft"]);
  await showCard(d, await reload(d, card.id));
  await askField(d, { chat_id: card.chat_id, thread_id: card.thread_id }, `w:${next}`, who, card.id, card.message_id);
}

/** Чернетка готова (або змінене поле) → перевірити таблицю і показати звичайні кнопки. */
async function finishDraft(d: Deps, card: CardRow, draft: Draft, who: Who, field?: string, value?: string) {
  const editingSaved = card.state !== "draft";
  if (!editingSaved) {
    // Спершу зберегти введене, потім перевіряти: якщо таблиця не відповість, значення не загубиться.
    await updateCard(d.db, card.id, { data: JSON.stringify(draft) }, ["draft"]);
    await recheckDraft(d, card.id, draft, await loadSettings(d.sheet));
  } else {
    const ev = await evaluateDraft(d, draft, card.id);
    await updateCard(
      d.db,
      card.id,
      {
        state: "editing",
        data: JSON.stringify(draft),
        body: ev.body,
        kb: JSON.stringify(draftKeyboard(card.id, ev.check, true)),
        bot_ok: botVerdictOk(ev.check) ? 1 : 0,
        error: null,
      },
      [card.state],
    );
    await showCard(d, await reload(d, card.id));
  }
  await audit(d.db, { user_id: who.id, user_name: who.name, action: field ? "edit" : "card_buttons", card_id: card.id, details: field ? { field, value } : toNewBooking(draft) });
}

/* ───────────── відповідь на ForceReply ───────────── */

/** Відповідь на запит «напишіть …». Повертає true, якщо повідомлення оброблено тут. */
export async function onPromptReply(
  d: Deps,
  msg: { chat_id: number; thread_id: number | null; message_id: number; reply_to: number; text: string },
  who: Who,
): Promise<boolean> {
  if (!isAdmin(who.id, d.env)) return false;
  const prompt = await takePrompt(d.db, msg.chat_id, msg.reply_to);
  if (!prompt) return false;
  const place: Place = { chat_id: msg.chat_id, thread_id: msg.thread_id };
  const text = msg.text.trim();

  // Прибираємо запит і відповідь, щоб гілка лишалась чистою (якщо в бота є право видаляти).
  await d.api.deleteMessage(msg.chat_id, msg.reply_to).catch(() => {});
  await d.api.deleteMessage(msg.chat_id, msg.message_id).catch(() => {});

  if (prompt.field === "search") {
    await showSearch(d, place, text, who);
    return true;
  }

  const card = prompt.card_id ? await getCard(d.db, prompt.card_id) : null;
  if (!card || !["draft", "editing", "saved"].includes(card.state)) return true;
  try {
    await applyPromptReply(d, card, prompt.field, text, place, who);
  } catch (err) {
    await reportCardError(d, card.id, err);
  }
  return true;
}

async function applyPromptReply(d: Deps, card: CardRow, promptField: string, text: string, place: Place, who: Who) {
  const prompt = { field: promptField };

  const wizard = prompt.field.startsWith("w:");
  const field = wizard ? prompt.field.slice(2) : prompt.field;
  const draft = draftOf(card);
  const settings = await loadSettings(d.sheet);
  const today = zonedNow(tz(d), now(d)).serial;
  let error: string | null = null;
  const hints: string[] = [];

  switch (field) {
    case "date": {
      const r = parseDateInput(text, { today, pcList: settings.pcList });
      if (r.date === null) error = "не зрозумів дату. Напишіть, напр., 21.11, завтра або пт.";
      else (draft.date = r.date), hints.push(...r.hints);
      break;
    }
    case "pcs": {
      const r = parsePcsInput(text, settings.pcList);
      if (!r.pcs.length) error = `не зрозумів ПК. Напишіть, напр., 12-17 або 12, 14, 16.${r.hints.length ? " " + r.hints.join("; ") : ""}`;
      else (draft.pcs = r.pcs), hints.push(...r.hints);
      break;
    }
    case "time": {
      const r = parseTimeInput(text);
      if (!r) error = "не зрозумів час. Напишіть, напр., 19-2, 18:00-22:00 або з 20:00 на 3 години.";
      else (draft.from = r.from), (draft.to = r.to);
      break;
    }
    case "name":
      if (!text || text === "-") error = "ім'я обов'язкове. Напишіть ім'я клієнта.";
      else draft.name = text.slice(0, 60);
      break;
    case "contact":
      draft.contact = text === "-" ? "" : normalizeContact(text).slice(0, 60);
      break;
    case "note":
      draft.note = text === "-" ? "" : text.slice(0, 200);
      break;
  }

  if (error) {
    await askField(d, place, prompt.field, who, card.id, card.message_id, error);
    return;
  }
  draft.hints = [...draft.hints.filter((h) => h.startsWith("🤖")), ...hints];

  if (wizard) await wizardStep(d, card, draft, WIZARD_NEXT[field] ?? null, who);
  else await finishDraft(d, card, draft, who, field, text);
}

/* ───────────── меню ───────────── */

async function sendInThread(d: Deps, place: Place, text: string, extra: Record<string, unknown> = {}) {
  return d.api.sendMessage(place.chat_id, text, {
    parse_mode: "HTML",
    message_thread_id: place.thread_id ?? undefined,
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

async function showSearch(d: Deps, place: Place, query: string, who: Who) {
  const snap = await readSnapshot(d.sheet);
  const entries = toEntries(snap.bookings, snap.settings.pcList);
  await sendInThread(d, place, searchView(entries, snap.settings, query, nowMin(d)));
  await audit(d.db, { user_id: who.id, user_name: who.name, action: "search", details: query });
}

/** Кнопки закріпленого меню: m:today / m:tomorrow / m:free / m:search / m:new. */
export async function onMenu(d: Deps, act: string, place: Place, who: Who, answer: Answer): Promise<void> {
  if (!isAdmin(who.id, d.env)) {
    await answer({ toast: "Немає доступу." });
    return;
  }
  try {
    await handleMenu(d, act, place, who, answer);
  } catch (err) {
    console.error("Меню", act, safeError(err));
    await answer({});
    await sendInThread(d, place, `❗ Не вдалося прочитати таблицю (${esc(err instanceof Error ? err.message : String(err))}). Спробуйте ще раз.`).catch(() => {});
  }
}

async function handleMenu(d: Deps, act: string, place: Place, who: Who, answer: Answer): Promise<void> {
  switch (act) {
    case "today":
    case "tomorrow":
    case "free": {
      await answer({ toast: "Дивлюся в таблицю…" });
      const snap = await readSnapshot(d.sheet);
      const entries = toEntries(snap.bookings, snap.settings.pcList);
      const at = nowMin(d);
      const today = businessDay(snap.settings.schedule, at);
      const text =
        act === "free"
          ? freeNowView(entries, snap.settings, at)
          : act === "today"
            ? dayView(entries, snap.settings, today, "Сьогодні")
            : dayView(entries, snap.settings, today + 1, "Завтра");
      await sendInThread(d, place, text);
      await audit(d.db, { user_id: who.id, user_name: who.name, action: `menu:${act}` });
      return;
    }
    case "search":
      await answer({});
      await askField(d, place, "search", who, null, null);
      return;
    case "new": {
      await answer({});
      const id = newBookingId(now(d).getTime());
      const settings = await loadSettings(d.sheet);
      const draft = emptyDraft();
      const body = [...fieldsBlock(draft, settings), "", "👉 Оберіть дату"].join("\n");
      const kb = dateKeyboard(id, zonedNow(tz(d), now(d)).serial);
      await createCard(d.db, { id, chat_id: place.chat_id, thread_id: place.thread_id, source_message_id: null, data: draft, body, user_id: who.id, user_name: who.name });
      await updateCard(d.db, id, { kb: JSON.stringify(kb) });
      const sent = await sendInThread(d, place, renderCard((await getCard(d.db, id))!), { reply_markup: kb });
      await updateCard(d.db, id, { message_id: sent.message_id });
      await audit(d.db, { user_id: who.id, user_name: who.name, action: "menu:new", card_id: id });
      return;
    }
    default:
      await answer({});
  }
}

/* ───────────── журнал ───────────── */

const ACTION_LABELS: Record<string, string> = {
  bind: "🔗 прив'язав гілку",
  card: "📝 картка з повідомлення",
  card_buttons: "📝 бронь кнопками готова",
  "menu:new": "➕ бронь кнопками",
  save: "✅ записав",
  update: "💾 змінив записану",
  edit: "✏️ змінив поле",
  cancel: "❌ відмінив чернетку",
  delete: "🗑 скасував бронь",
  delete_missing: "🗑 скасував (рядка вже не було)",
  missing: "⚠ броні немає в таблиці",
  changed_in_sheet: "ℹ️ бронь змінено в таблиці вручну",
  recreate: "➕ записати заново",
  close_missing: "✖️ закрив картку",
  save_error: "❗ помилка запису",
  verify_error: "❗ помилка перевірки",
  verify_mismatch: "❗ бот і таблиця розходяться",
  search: "🔎 пошук",
  "menu:today": "📅 сьогодні",
  "menu:tomorrow": "📅 завтра",
  "menu:free": "🟢 вільні зараз",
  came: "✅ відмітив «прийшов»",
  no_show: "❌ відмітив «не прийшов»",
  attendance_error: "❗ відмітка не записана",
  client_book: "🎮 клієнт забронював",
  client_cancel: "🗑 клієнт скасував",
  client_confirm: "👍 клієнт підтвердив",
};

/** Останні дії (для /log власника). */
export async function auditText(d: Deps, limit = 25): Promise<string> {
  const rows = await recentAudit(d.db, limit);
  if (!rows.length) return "📜 Журнал порожній.";
  const lines = rows.map((r) => {
    const when = stampOf(d, new Date(r.at.replace(" ", "T") + "Z"));
    const who = r.user_name ? esc(r.user_name) : "бот";
    let extra = "";
    if (r.action === "search" && r.details) extra = ` «${esc(JSON.parse(r.details) as string)}»`;
    if (r.card_id) extra += ` · <code>${r.card_id}</code>`;
    return `${when} · ${who} · ${ACTION_LABELS[r.action] ?? esc(r.action)}${extra}`;
  });
  return ["📜 <b>Останні дії</b>", ...lines.reverse()].join("\n");
}
