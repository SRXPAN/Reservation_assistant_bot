// Логіка клієнтського самозапису в особистих повідомленнях (`chat.type === 'private'`).
// Покроковий інлайн-майстер у одному повідомленні, «Мої броні», антиспам-ліміт (макс. 2 активні броні),
// ізоляція даних через `PublicSlotSummary`, захист від IDOR і сповіщення виключно у закритий адмін-канал.

import {
  allocateContiguousPCs,
  availableZones,
  findAvailableDurations,
  findAvailableStartTimes,
  intervalToBookingTime,
  newBookingId,
  zonePCs,
  type NewBooking,
  type PublicSlotSummary,
} from "./bookings";
import {
  adminClientCancelledText,
  adminNewClientBookingText,
  clientConfirmDetails,
  clientConfirmKeyboard,
  clientContactKeyboard,
  clientCountKeyboard,
  clientDateKeyboard,
  clientDurationKeyboard,
  clientEditMenuKeyboard,
  clientInfoText,
  clientMainMenuKeyboard,
  clientNameKeyboard,
  clientPickPcsKeyboard,
  clientTimeKeyboard,
  clientWelcomeText,
  clientZoneKeyboard,
  durationLabel,
  esc,
  pcsLabel,
  type Keyboard,
} from "./card";
import type { CallbackResult, Deps } from "./flow";
import { windowOf } from "./hours";
import { safeError } from "./log";
import { clientReminderKeyboard, onClientReminderConfirm } from "./reminders";
import {
  BookingConflictError,
  BookingOutOfHoursError,
  SheetFullError,
  clearBooking,
  loadSettings,
  placeClientBooking,
  readAuthorizedClientBooking,
  readClientOwnBookings,
  readPublicSnapshot,
  type Settings,
} from "./sheet";
import {
  audit,
  clearClientSession,
  getAdminChannel,
  getAuthorizedClientBooking,
  getClientSession,
  markClientBookingCancelled,
  saveClientBooking,
  saveClientSession,
  transitionClientSession,
} from "./store";
import { MIN_PER_DAY, formatDate, formatHHMM, nowAbs, zonedNow } from "./time";
import { businessDay, publicAvailabilityView } from "./views";

export const MAX_CLIENT_BOOKINGS = 2;
export const MAX_CLIENT_PCS = 5;
export const CLIENT_NOTE = "клієнт через бот";
export const NEUTRAL_BOOKING_ERROR = "Бронь недоступна.";

export interface ClientUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  displayName: string;
}

type Answer = (r: CallbackResult) => Promise<void>;

interface ClientWizardData {
  daySerial?: number;
  zone?: string;
  count?: number;
  pickedPcs?: number[];
  preferredPcs?: number[];
  startAbs?: number;
  durationMin?: number;
  pcs?: number[];
  name?: string;
  contact?: string;
  phonePromptMsgId?: number;
  editing?: boolean;
}

interface PublicSnapshot {
  busySlots: PublicSlotSummary[];
  settings: Settings;
}

const now = (d: Deps) => (d.now ? d.now() : new Date());
const tz = (d: Deps) => d.env.TZ || "Europe/Warsaw";
const nowMin = (d: Deps) => nowAbs(tz(d), now(d));
const notModified = (err: unknown) => String(err).includes("message is not modified");

async function editWizard(d: Deps, chatId: number, messageId: number, text: string, reply_markup: Keyboard) {
  await d.api
    .editMessageText(chatId, messageId, text, {
      parse_mode: "HTML",
      reply_markup,
      link_preview_options: { is_disabled: true },
    })
    .catch((err) => {
      if (!notModified(err)) throw err;
    });
}

async function cleanupPhonePrompt(d: Deps, chatId: number, data: ClientWizardData) {
  if (!data.phonePromptMsgId) return;
  await d.api.deleteMessage(chatId, data.phonePromptMsgId).catch(() => {});
  data.phonePromptMsgId = undefined;
  const rm = await d.api
    .sendMessage(chatId, "✓", { reply_markup: { remove_keyboard: true } })
    .catch(() => null);
  if (rm) await d.api.deleteMessage(chatId, rm.message_id).catch(() => {});
}

async function notifyAdmins(d: Deps, text: string) {
  const channel = await getAdminChannel(d.db, d.env);
  if (!channel) return;
  await d.api
    .sendMessage(channel.chat_id, text, {
      parse_mode: "HTML",
      message_thread_id: channel.thread_id ?? undefined,
      link_preview_options: { is_disabled: true },
    })
    .catch((err) => console.error("Сповіщення адміну", safeError(err)));
}

function headerSummary(data: ClientWizardData, pcList: number[]): string {
  const lines: string[] = [];
  if (data.daySerial !== undefined) lines.push(`📅 <b>Дата:</b> ${formatDate(data.daySerial)}`);
  if (data.zone) lines.push(`💻 <b>Зона:</b> ${esc(data.zone)}${data.count ? ` · ${data.count} ПК` : ""}`);
  if (data.preferredPcs?.length) lines.push(`🔢 <b>Обрані ПК:</b> ${pcsLabel(data.preferredPcs, pcList)}`);
  if (data.startAbs !== undefined) {
    if (data.durationMin) {
      const endAbs = data.startAbs + data.durationMin;
      const endStr = endAbs % MIN_PER_DAY === 0 ? "24:00" : formatHHMM(endAbs);
      lines.push(`🕒 <b>Час:</b> ${formatHHMM(data.startAbs)} – ${endStr} (${durationLabel(data.durationMin)})`);
    } else {
      lines.push(`🕒 <b>Початок:</b> ${formatHHMM(data.startAbs)}`);
    }
  }
  return lines.join("\n");
}

/* ───────────── відображення кроків майстра (виключно PublicSlotSummary) ───────────── */

async function showDateStep(d: Deps, chatId: number, msgId: number, userId: number, data: ClientWizardData, settings: Settings) {
  const at = nowMin(d);
  const calToday = zonedNow(tz(d), now(d)).serial;
  const bizToday = businessDay(settings.schedule, at);
  await saveClientSession(d.db, { user_id: userId, message_id: msgId, step: "date", data });
  await editWizard(
    d,
    chatId,
    msgId,
    "📅 <b>Крок 1/6 · Оберіть дату</b>\n\nОберіть день бронювання з найближчих 7 днів:",
    clientDateKeyboard(bizToday, calToday, settings.schedule),
  );
}

async function showZoneStep(d: Deps, chatId: number, msgId: number, userId: number, data: ClientWizardData, settings: Settings) {
  const zones = availableZones(settings.pcList, settings.zones);
  await saveClientSession(d.db, { user_id: userId, message_id: msgId, step: "zone", data });
  const head = headerSummary(data, settings.pcList);
  await editWizard(
    d,
    chatId,
    msgId,
    `${head}\n\n💻 <b>Крок 2/6 · Оберіть ігрову зону</b>`,
    clientZoneKeyboard(zones),
  );
}

async function showCountStep(d: Deps, chatId: number, msgId: number, userId: number, data: ClientWizardData, settings: Settings) {
  const zPcs = zonePCs(settings.pcList, settings.zones, data.zone!);
  await saveClientSession(d.db, { user_id: userId, message_id: msgId, step: "count", data });
  const head = headerSummary({ ...data, count: undefined, preferredPcs: undefined }, settings.pcList);
  await editWizard(
    d,
    chatId,
    msgId,
    `${head}\n\n👥 <b>Кількість ПК</b>\nОберіть скільки комп'ютерів потрібно (автоматично підберемо суміжні) або вкажіть конкретні номери:`,
    clientCountKeyboard(zPcs.length, MAX_CLIENT_PCS),
  );
}

async function showPickPcsStep(d: Deps, chatId: number, msgId: number, userId: number, data: ClientWizardData, settings: Settings) {
  const zPcs = zonePCs(settings.pcList, settings.zones, data.zone!);
  const selected = data.pickedPcs ?? [];
  await saveClientSession(d.db, { user_id: userId, message_id: msgId, step: "pick_pcs", data });
  const head = headerSummary({ ...data, count: undefined, preferredPcs: undefined }, settings.pcList);
  await editWizard(
    d,
    chatId,
    msgId,
    `${head}\n\n🔢 <b>Оберіть конкретні номери ПК</b> (від 1 до ${MAX_CLIENT_PCS}):`,
    clientPickPcsKeyboard(zPcs, selected),
  );
}

async function showTimeStep(
  d: Deps,
  chatId: number,
  msgId: number,
  userId: number,
  data: ClientWizardData,
  pub: PublicSnapshot,
  customNotice?: string,
) {
  const zPcs = zonePCs(pub.settings.pcList, pub.settings.zones, data.zone!);
  const slots = findAvailableStartTimes({
    daySerial: data.daySerial!,
    schedule: pub.settings.schedule,
    zonePcs: zPcs,
    count: data.count!,
    bookings: pub.busySlots,
    nowAbs: nowMin(d),
    stepMinutes: 60,
    minDurationMinutes: 60,
    preferredPcs: data.preferredPcs,
  });
  await saveClientSession(d.db, { user_id: userId, message_id: msgId, step: "time", data });
  const head = headerSummary({ ...data, startAbs: undefined, durationMin: undefined }, pub.settings.pcList);
  if (!slots.length) {
    await editWizard(
      d,
      chatId,
      msgId,
      `${head}\n\n😔 ${customNotice ?? "На обрану дату немає вільних годин для цих параметрів."}`,
      {
        inline_keyboard: [
          [
            { text: "⬅️ Назад", callback_data: "c:back" },
            { text: "❌ Скасувати", callback_data: "c:cancel" },
          ],
        ],
      },
    );
    return;
  }
  const prompt = customNotice ?? "🕒 <b>Крок 3/6 · Оберіть час початку</b>\n\nПоказані лише години, коли потрібна кількість ПК вільна:";
  await editWizard(d, chatId, msgId, `${head}\n\n${prompt}`, clientTimeKeyboard(slots, data.daySerial!));
}

async function showDurationStep(d: Deps, chatId: number, msgId: number, userId: number, data: ClientWizardData, pub: PublicSnapshot) {
  const zPcs = zonePCs(pub.settings.pcList, pub.settings.zones, data.zone!);
  const options = findAvailableDurations({
    startAbs: data.startAbs!,
    schedule: pub.settings.schedule,
    zonePcs: zPcs,
    count: data.count!,
    bookings: pub.busySlots,
    preferredPcs: data.preferredPcs,
  });
  await saveClientSession(d.db, { user_id: userId, message_id: msgId, step: "duration", data });
  const head = headerSummary({ ...data, durationMin: undefined }, pub.settings.pcList);
  if (!options.length) {
    await editWizard(d, chatId, msgId, `${head}\n\n⚠️ На цей час уже немає доступних слотів. Оберіть інший час початку.`, {
      inline_keyboard: [
        [
          { text: "⬅️ Назад", callback_data: "c:back" },
          { text: "❌ Скасувати", callback_data: "c:cancel" },
        ],
      ],
    });
    return;
  }
  await editWizard(
    d,
    chatId,
    msgId,
    `${head}\n\n⏱ <b>Крок 4/6 · Оберіть тривалість</b>`,
    clientDurationKeyboard(options),
  );
}

async function showNameStep(d: Deps, chatId: number, msgId: number, user: ClientUser, data: ClientWizardData, settings: Settings) {
  await saveClientSession(d.db, { user_id: user.id, message_id: msgId, step: "name", data });
  const tgName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const head = headerSummary(data, settings.pcList);
  await editWizard(
    d,
    chatId,
    msgId,
    `${head}\n\n👤 <b>Крок 5/6 · Ваше ім'я</b>\n\nЯк вас записати на бронь?`,
    clientNameKeyboard(tgName),
  );
}

async function enterPhoneInput(
  d: Deps,
  chatId: number,
  msgId: number,
  user: ClientUser,
  data: ClientWizardData,
  settings: Settings,
  errorText?: string,
) {
  const head = headerSummary(data, settings.pcList);
  const body =
    errorText ??
    "📞 <b>Крок 6/6 · Контакт для зв'язку</b>\n\nПоділіться номером телефону кнопкою нижче або введіть його повідомленням (напр. <code>+48 501 234 567</code>):";
  await editWizard(d, chatId, msgId, `${head}\n\n${body}`, clientContactKeyboard(false));
  if (!data.phonePromptMsgId) {
    const sent = await d.api.sendMessage(chatId, "👇 Натисніть кнопку нижче, щоб поділитися номером, або надішліть його текстом:", {
      reply_markup: {
        keyboard: [[{ text: "📱 Поділитися номером телефону", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
    data.phonePromptMsgId = sent.message_id;
  }
  await saveClientSession(d.db, { user_id: user.id, message_id: msgId, step: "phone_input", data });
}

async function showContactStep(d: Deps, chatId: number, msgId: number, user: ClientUser, data: ClientWizardData, settings: Settings) {
  if (user.username) {
    await saveClientSession(d.db, { user_id: user.id, message_id: msgId, step: "contact", data });
    const head = headerSummary(data, settings.pcList);
    await editWizard(
      d,
      chatId,
      msgId,
      `${head}\n\n📞 <b>Крок 6/6 · Контакт для зв'язку</b>\n\nВаш Telegram: <code>@${esc(user.username)}</code>\nБажаєте також додати номер телефону?`,
      clientContactKeyboard(true),
    );
  } else {
    await enterPhoneInput(d, chatId, msgId, user, data, settings);
  }
}

async function showConfirmStep(d: Deps, chatId: number, msgId: number, userId: number, data: ClientWizardData, settings: Settings) {
  await saveClientSession(d.db, { user_id: userId, message_id: msgId, step: "confirm", data });
  const details = clientConfirmDetails(
    {
      startAbs: data.startAbs!,
      durationMin: data.durationMin!,
      zone: data.zone!,
      pcs: data.pcs!,
      name: data.name!,
      contact: data.contact!,
    },
    settings.pcList,
  );
  await editWizard(
    d,
    chatId,
    msgId,
    `📝 <b>Перевірте деталі бронювання</b>\n\n${details}\n\nНатисніть «Підтвердити бронь», щоб забронювати ПК.`,
    clientConfirmKeyboard(),
  );
}

/* ───────────── «Мої броні» та захист від IDOR ───────────── */

async function showMyBookings(d: Deps, chatId: number, msgId: number, userId: number) {
  const { bookings, settings } = await readClientOwnBookings(d.sheet, d.db, userId, nowMin(d));
  if (!bookings.length) {
    await editWizard(
      d,
      chatId,
      msgId,
      "📋 <b>Мої броні</b>\n\nУ вас поки немає активних майбутніх бронювань.",
      {
        inline_keyboard: [
          [{ text: "🎮 Забронювати ПК", callback_data: "c:book" }],
          [{ text: "⬅️ Головне меню", callback_data: "c:menu" }],
        ],
      },
    );
    return;
  }

  const blocks = bookings.map((b, i) => {
    const endStr = b.end % MIN_PER_DAY === 0 ? "24:00" : formatHHMM(b.end);
    return `${i + 1}. 📅 <b>${formatDate(b.date)}</b> · ${formatHHMM(b.start)}–${endStr}\n   💻 ${pcsLabel(b.pcs, settings.pcList)}${b.zone ? ` (${esc(b.zone)})` : ""} · 👤 ${esc(b.name)}`;
  });
  const actionRows = bookings.map((b) => [
    { text: `👁 Деталі (${formatDate(b.date).slice(0, 5)} ${formatHHMM(b.start)})`, callback_data: `c:myview:${b.id}` },
    { text: "❌ Скасувати", callback_data: `c:mycan:${b.id}` },
  ]);
  await editWizard(
    d,
    chatId,
    msgId,
    `📋 <b>Мої активні броні</b> (${bookings.length}/${MAX_CLIENT_BOOKINGS}):\n\n${blocks.join("\n\n")}`,
    {
      inline_keyboard: [...actionRows, [{ text: "⬅️ Головне меню", callback_data: "c:menu" }]],
    },
  );
}

async function performClientCancel(
  d: Deps,
  bookingId: string,
  chatId: number,
  msgId: number,
  user: ClientUser,
  answer: Answer,
) {
  const authorized = await readAuthorizedClientBooking(d.sheet, d.db, bookingId, user.id, d.env);
  if (!authorized) {
    await answer({ toast: NEUTRAL_BOOKING_ERROR });
    return;
  }
  await answer({ toast: "Скасовую…" });

  await clearBooking(d.sheet, bookingId);
  await markClientBookingCancelled(d.db, bookingId);
  await audit(d.db, {
    user_id: user.id,
    user_name: user.displayName,
    action: "client_cancel",
    card_id: bookingId,
  });

  await notifyAdmins(d, adminClientCancelledText(authorized.booking, authorized.settings.pcList));
  await editWizard(d, chatId, msgId, "🗑 <b>Бронь скасовано.</b>", {
    inline_keyboard: [
      [
        { text: "📋 Мої броні", callback_data: "c:my" },
        { text: "🏠 Головне меню", callback_data: "c:menu" },
      ],
    ],
  });
}

/* ───────────── публічні обробники (тільки chatType === 'private') ───────────── */

export async function onClientStart(d: Deps, user: ClientUser, chatType: string = "private"): Promise<void> {
  if (chatType !== "private") return;
  const existing = await getClientSession(d.db, user.id);
  if (existing) {
    const data = JSON.parse(existing.data) as ClientWizardData;
    await cleanupPhonePrompt(d, user.id, data);
    await clearClientSession(d.db, user.id);
  }
  await d.api.sendMessage(user.id, clientWelcomeText(), {
    parse_mode: "HTML",
    reply_markup: clientMainMenuKeyboard(),
    link_preview_options: { is_disabled: true },
  });
}

export async function onClientCallback(
  d: Deps,
  q: { data: string; chat_id: number; message_id: number; chat_type?: string },
  user: ClientUser,
  answer: Answer,
): Promise<void> {
  if ((q.chat_type ?? "private") !== "private") {
    await answer({ toast: "Доступно лише в особистих повідомленнях." });
    return;
  }
  try {
    await handleClientCallback(d, q, user, answer);
  } catch (err) {
    console.error("Помилка клієнтського меню", q.data.split(":")[1] ?? "unknown", safeError(err));
    await answer({});
    await editWizard(
      d,
      q.chat_id,
      q.message_id,
      "❗ Тимчасова помилка. Спробуйте ще раз.",
      { inline_keyboard: [[{ text: "⬅️ Головне меню", callback_data: "c:menu" }]] },
    ).catch(() => {});
  }
}

async function handleClientCallback(
  d: Deps,
  q: { data: string; chat_id: number; message_id: number },
  user: ClientUser,
  answer: Answer,
): Promise<void> {
  const dataStr = q.data;

  // Нагадування клієнту за 30 хв (з обов'язковою перевіркою власника для кожної дії)
  if (dataStr.startsWith("c:rem:")) {
    const rest = dataStr.slice("c:rem:".length);
    const sep = rest.indexOf(":");
    const act = sep === -1 ? rest : rest.slice(0, sep);
    const bookingId = sep === -1 ? "" : rest.slice(sep + 1);
    const who = { id: user.id, name: user.displayName };

    if (act === "ok") {
      return onClientReminderConfirm(d, bookingId, { chat_id: q.chat_id, message_id: q.message_id }, who, answer);
    }
    if (act === "can") {
      const owner = await getAuthorizedClientBooking(d.db, bookingId, user.id, d.env);
      if (!owner) return answer({ toast: NEUTRAL_BOOKING_ERROR });
      await answer({});
      await editWizard(d, q.chat_id, q.message_id, "❓ Ви впевнені, що хочете скасувати бронь?", {
        inline_keyboard: [
          [{ text: "✅ Так, скасувати", callback_data: `c:rem:canok:${bookingId}` }],
          [{ text: "⬅️ Назад", callback_data: `c:rem:back:${bookingId}` }],
        ],
      });
      return;
    }
    if (act === "back") {
      const owner = await getAuthorizedClientBooking(d.db, bookingId, user.id, d.env);
      if (!owner) return answer({ toast: NEUTRAL_BOOKING_ERROR });
      await answer({});
      const row = await d.db
        .prepare("SELECT text FROM sent_reminders WHERE chat_id = ?1 AND message_id = ?2")
        .bind(q.chat_id, q.message_id)
        .first<{ text: string | null }>();
      await editWizard(
        d,
        q.chat_id,
        q.message_id,
        row?.text ?? "⏰ Нагадування про вашу бронь. Все в силі?",
        clientReminderKeyboard(bookingId),
      );
      return;
    }
    if (act === "canok") {
      return performClientCancel(d, bookingId, q.chat_id, q.message_id, user, answer);
    }
    return answer({});
  }

  // Головне меню
  if (dataStr === "c:menu") {
    await answer({});
    const existing = await getClientSession(d.db, user.id);
    if (existing) {
      await cleanupPhonePrompt(d, q.chat_id, JSON.parse(existing.data) as ClientWizardData);
      await clearClientSession(d.db, user.id);
    }
    await editWizard(d, q.chat_id, q.message_id, clientWelcomeText(), clientMainMenuKeyboard());
    return;
  }

  if (dataStr === "c:info") {
    await answer({});
    const pub = await readPublicSnapshot(d.sheet);
    const availability = publicAvailabilityView(pub.busySlots, pub.settings, nowMin(d));
    await editWizard(d, q.chat_id, q.message_id, `${clientInfoText(pub.settings)}\n\n${availability}`, {
      inline_keyboard: [
        [{ text: "🎮 Забронювати ПК", callback_data: "c:book" }],
        [{ text: "⬅️ Головне меню", callback_data: "c:menu" }],
      ],
    });
    return;
  }

  if (dataStr === "c:my") {
    await answer({ toast: "Оновлюю…" });
    await showMyBookings(d, q.chat_id, q.message_id, user.id);
    return;
  }

  if (dataStr.startsWith("c:myview:")) {
    const bookingId = dataStr.slice("c:myview:".length);
    const authorized = await readAuthorizedClientBooking(d.sheet, d.db, bookingId, user.id, d.env);
    if (!authorized) return answer({ toast: NEUTRAL_BOOKING_ERROR });
    await answer({});
    const b = authorized.booking;
    const details = clientConfirmDetails(
      {
        startAbs: b.start,
        durationMin: b.end - b.start,
        zone: b.zone || "Загальна",
        pcs: b.pcs,
        name: b.name,
        contact: b.contact || "—",
      },
      authorized.settings.pcList,
    );
    await editWizard(d, q.chat_id, q.message_id, `📌 <b>Деталі бронювання</b>\n\n${details}`, {
      inline_keyboard: [
        [{ text: "❌ Скасувати бронь", callback_data: `c:mycan:${b.id}` }],
        [{ text: "⬅️ Мої броні", callback_data: "c:my" }],
      ],
    });
    return;
  }

  if (dataStr.startsWith("c:mycan:")) {
    const bookingId = dataStr.slice("c:mycan:".length);
    const owner = await getAuthorizedClientBooking(d.db, bookingId, user.id, d.env);
    if (!owner) return answer({ toast: NEUTRAL_BOOKING_ERROR });
    await answer({});
    await editWizard(d, q.chat_id, q.message_id, "❓ <b>Підтвердіть скасування броні</b>\n\nВи дійсно хочете скасувати цю бронь?", {
      inline_keyboard: [
        [{ text: "✅ Так, скасувати", callback_data: `c:mycanok:${bookingId}` }],
        [{ text: "⬅️ Назад", callback_data: "c:my" }],
      ],
    });
    return;
  }

  if (dataStr.startsWith("c:mycanok:")) {
    const bookingId = dataStr.slice("c:mycanok:".length);
    return performClientCancel(d, bookingId, q.chat_id, q.message_id, user, answer);
  }

  // Старт нового бронювання + перевірка антиспам-ліміту (макс. 2 активні броні)
  if (dataStr === "c:book") {
    await answer({});
    const existing = await getClientSession(d.db, user.id);
    if (existing) {
      await cleanupPhonePrompt(d, q.chat_id, JSON.parse(existing.data) as ClientWizardData);
      await clearClientSession(d.db, user.id);
    }
    const { bookings, settings } = await readClientOwnBookings(d.sheet, d.db, user.id, nowMin(d));
    if (bookings.length >= MAX_CLIENT_BOOKINGS) {
      await editWizard(
        d,
        q.chat_id,
        q.message_id,
        `⚠️ <b>Досягнуто ліміт бронювань</b>\n\nВи можете мати не більше <b>${MAX_CLIENT_BOOKINGS}</b> активних майбутніх броней одночасно.\n\nВи можете переглянути або скасувати одну з існуючих броней у розділі «Мої броні».`,
        {
          inline_keyboard: [
            [{ text: "📋 Мої броні", callback_data: "c:my" }],
            [{ text: "⬅️ Головне меню", callback_data: "c:menu" }],
          ],
        },
      );
      return;
    }
    await showDateStep(d, q.chat_id, q.message_id, user.id, {}, settings);
    return;
  }

  // Далі — кроки активної сесії майстра
  const session = await getClientSession(d.db, user.id);
  if (dataStr === "c:cancel") {
    await answer({ toast: "Бронювання скасовано" });
    if (session) {
      await cleanupPhonePrompt(d, q.chat_id, JSON.parse(session.data) as ClientWizardData);
      await clearClientSession(d.db, user.id);
    }
    await editWizard(d, q.chat_id, q.message_id, clientWelcomeText(), clientMainMenuKeyboard());
    return;
  }

  if (!session || (session.message_id !== null && session.message_id !== q.message_id)) {
    return answer({ toast: "Ця форма застаріла. Почніть спочатку." });
  }

  const data = JSON.parse(session.data) as ClientWizardData;

  if (dataStr === "c:back") {
    await answer({});
    const settings = await loadSettings(d.sheet);
    switch (session.step) {
      case "zone":
        return showDateStep(d, q.chat_id, q.message_id, user.id, {}, settings);
      case "count":
        return showZoneStep(d, q.chat_id, q.message_id, user.id, { daySerial: data.daySerial }, settings);
      case "pick_pcs":
        return showCountStep(d, q.chat_id, q.message_id, user.id, { daySerial: data.daySerial, zone: data.zone }, settings);
      case "time":
        if (data.preferredPcs?.length) {
          return showPickPcsStep(
            d,
            q.chat_id,
            q.message_id,
            user.id,
            { daySerial: data.daySerial, zone: data.zone, pickedPcs: data.preferredPcs },
            settings,
          );
        }
        return showCountStep(d, q.chat_id, q.message_id, user.id, { daySerial: data.daySerial, zone: data.zone }, settings);
      case "duration": {
        const pub = await readPublicSnapshot(d.sheet);
        return showTimeStep(d, q.chat_id, q.message_id, user.id, data, pub);
      }
      case "name": {
        const pub = await readPublicSnapshot(d.sheet);
        return showDurationStep(d, q.chat_id, q.message_id, user.id, data, pub);
      }
      case "name_input":
        return showNameStep(d, q.chat_id, q.message_id, user, data, settings);
      case "contact":
        return showNameStep(d, q.chat_id, q.message_id, user, data, settings);
      case "phone_input":
        await cleanupPhonePrompt(d, q.chat_id, data);
        if (user.username) return showContactStep(d, q.chat_id, q.message_id, user, data, settings);
        return showNameStep(d, q.chat_id, q.message_id, user, data, settings);
      case "confirm":
        return showContactStep(d, q.chat_id, q.message_id, user, data, settings);
      default:
        return showDateStep(d, q.chat_id, q.message_id, user.id, {}, settings);
    }
  }

  // Крок 1: Дата
  if (dataStr.startsWith("c:d:")) {
    const daySerial = Number(dataStr.slice("c:d:".length));
    const settings = await loadSettings(d.sheet);
    const w = windowOf(settings.schedule, daySerial);
    if (w.end <= w.start) {
      return answer({ toast: "У цей день клуб зачинений" });
    }
    await answer({});
    data.daySerial = daySerial;
    data.startAbs = undefined;
    data.durationMin = undefined;
    data.pcs = undefined;
    data.editing = false;
    return showZoneStep(d, q.chat_id, q.message_id, user.id, data, settings);
  }

  // Крок 2а: Зона
  if (dataStr.startsWith("c:z:")) {
    const idx = Number(dataStr.slice("c:z:".length));
    const settings = await loadSettings(d.sheet);
    const zones = availableZones(settings.pcList, settings.zones);
    const zone = zones[idx];
    if (!zone) return answer({ toast: "Зону не знайдено" });
    await answer({});
    data.zone = zone;
    data.count = undefined;
    data.pickedPcs = undefined;
    data.preferredPcs = undefined;
    data.startAbs = undefined;
    data.durationMin = undefined;
    data.pcs = undefined;
    return showCountStep(d, q.chat_id, q.message_id, user.id, data, settings);
  }

  // Крок 2б: Кількість ПК
  if (dataStr.startsWith("c:n:")) {
    const count = Number(dataStr.slice("c:n:".length));
    if (!Number.isInteger(count) || count < 1 || count > MAX_CLIENT_PCS) {
      return answer({ toast: "Некоректна кількість ПК" });
    }
    await answer({ toast: "Шукаю вільний час…" });
    data.count = count;
    data.preferredPcs = undefined;
    data.pickedPcs = undefined;
    const pub = await readPublicSnapshot(d.sheet);
    return showTimeStep(d, q.chat_id, q.message_id, user.id, data, pub);
  }

  if (dataStr === "c:more") {
    await answer({});
    const settings = await loadSettings(d.sheet);
    const head = headerSummary(data, settings.pcList);
    await editWizard(
      d,
      q.chat_id,
      q.message_id,
      `${head}\n\n👥 <b>Бронювання понад ${MAX_CLIENT_PCS} ПК</b>\n\nДля великих компаній (більше 5 ПК) будь ласка, зв'яжіться з адміністратором клубу напряму, щоб ми зручно розсадили вашу групу.`,
      {
        inline_keyboard: [
          [
            { text: "⬅️ Обрати до 5 ПК", callback_data: "c:back" },
            { text: "🏠 Головне меню", callback_data: "c:menu" },
          ],
        ],
      },
    );
    return;
  }

  if (dataStr === "c:pick") {
    await answer({});
    const settings = await loadSettings(d.sheet);
    data.pickedPcs = data.preferredPcs ? [...data.preferredPcs] : [];
    return showPickPcsStep(d, q.chat_id, q.message_id, user.id, data, settings);
  }

  if (dataStr.startsWith("c:pc:")) {
    const pc = Number(dataStr.slice("c:pc:".length));
    const settings = await loadSettings(d.sheet);
    const zPcs = zonePCs(settings.pcList, settings.zones, data.zone!);
    if (!zPcs.includes(pc)) return answer({ toast: "Некоректний ПК" });
    const picked = new Set(data.pickedPcs ?? []);
    if (picked.has(pc)) {
      picked.delete(pc);
    } else {
      if (picked.size >= MAX_CLIENT_PCS) {
        return answer({ toast: `Максимум ${MAX_CLIENT_PCS} ПК в одній броні` });
      }
      picked.add(pc);
    }
    await answer({});
    data.pickedPcs = [...picked].sort((a, b) => a - b);
    return showPickPcsStep(d, q.chat_id, q.message_id, user.id, data, settings);
  }

  if (dataStr === "c:pcok") {
    const picked = [...(data.pickedPcs ?? [])].sort((a, b) => a - b);
    if (!picked.length) return answer({ toast: "Оберіть хоча б один ПК" });
    await answer({ toast: "Шукаю вільний час…" });
    data.preferredPcs = picked;
    data.count = picked.length;
    const pub = await readPublicSnapshot(d.sheet);
    return showTimeStep(d, q.chat_id, q.message_id, user.id, data, pub);
  }

  // Крок 3: Час початку
  if (dataStr.startsWith("c:t:")) {
    const startAbs = Number(dataStr.slice("c:t:".length));
    if (!Number.isFinite(startAbs)) return answer({ toast: "Некоректний час" });
    await answer({});
    data.startAbs = startAbs;
    data.durationMin = undefined;
    data.pcs = undefined;
    const pub = await readPublicSnapshot(d.sheet);
    return showDurationStep(d, q.chat_id, q.message_id, user.id, data, pub);
  }

  // Крок 4: Тривалість
  if (dataStr.startsWith("c:dur:")) {
    const minutes = Number(dataStr.slice("c:dur:".length));
    const pub = await readPublicSnapshot(d.sheet);
    const zPcs = zonePCs(pub.settings.pcList, pub.settings.zones, data.zone!);
    const pcs = allocateContiguousPCs({
      zonePcs: zPcs,
      count: data.count!,
      start: data.startAbs!,
      end: data.startAbs! + minutes,
      bookings: pub.busySlots,
      preferredPcs: data.preferredPcs,
    });
    if (!pcs) {
      await answer({ toast: "Ці ПК щойно зайняли" });
      return showTimeStep(
        d,
        q.chat_id,
        q.message_id,
        user.id,
        data,
        pub,
        "⚠️ На обрану тривалість ці ПК щойно зайняли. Оберіть інший час:",
      );
    }
    await answer({});
    data.durationMin = minutes;
    data.pcs = pcs;
    return showNameStep(d, q.chat_id, q.message_id, user, data, pub.settings);
  }

  // Крок 5: Ім'я
  if (dataStr === "c:nm:tg") {
    const tgName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    if (!tgName) return answer({ toast: "Введіть ім'я вручну" });
    await answer({});
    data.name = tgName.slice(0, 60);
    const settings = await loadSettings(d.sheet);
    if (data.editing && data.contact) {
      data.editing = false;
      return showConfirmStep(d, q.chat_id, q.message_id, user.id, data, settings);
    }
    return showContactStep(d, q.chat_id, q.message_id, user, data, settings);
  }

  if (dataStr === "c:nm:edit") {
    await answer({});
    const settings = await loadSettings(d.sheet);
    await saveClientSession(d.db, { user_id: user.id, message_id: q.message_id, step: "name_input", data });
    const head = headerSummary(data, settings.pcList);
    await editWizard(d, q.chat_id, q.message_id, `${head}\n\n✏️ <b>Надішліть ваше ім'я</b> повідомленням у чат:`, {
      inline_keyboard: [
        [
          { text: "⬅️ Назад", callback_data: "c:back" },
          { text: "❌ Скасувати", callback_data: "c:cancel" },
        ],
      ],
    });
    return;
  }

  // Крок 6: Контакт
  if (dataStr === "c:ct:skip") {
    if (!user.username) return answer({ toast: "Потрібен номер телефону" });
    await answer({});
    data.contact = `@${user.username}`;
    data.editing = false;
    const settings = await loadSettings(d.sheet);
    return showConfirmStep(d, q.chat_id, q.message_id, user.id, data, settings);
  }

  if (dataStr === "c:ct:phone") {
    await answer({});
    const settings = await loadSettings(d.sheet);
    return enterPhoneInput(d, q.chat_id, q.message_id, user, data, settings);
  }

  // Крок 7: Редагування або підтвердження
  if (dataStr === "c:edit") {
    await answer({});
    const settings = await loadSettings(d.sheet);
    const details = clientConfirmDetails(
      {
        startAbs: data.startAbs!,
        durationMin: data.durationMin!,
        zone: data.zone!,
        pcs: data.pcs!,
        name: data.name!,
        contact: data.contact!,
      },
      settings.pcList,
    );
    await editWizard(d, q.chat_id, q.message_id, `✏️ <b>Що бажаєте змінити?</b>\n\n${details}`, clientEditMenuKeyboard());
    return;
  }

  if (dataStr.startsWith("c:ed:")) {
    const what = dataStr.slice("c:ed:".length);
    await answer({});
    const settings = await loadSettings(d.sheet);
    if (what === "back") return showConfirmStep(d, q.chat_id, q.message_id, user.id, data, settings);
    if (what === "date") {
      data.editing = false;
      return showDateStep(d, q.chat_id, q.message_id, user.id, data, settings);
    }
    if (what === "zone") {
      data.editing = false;
      return showZoneStep(d, q.chat_id, q.message_id, user.id, data, settings);
    }
    if (what === "time") {
      data.editing = false;
      const pub = await readPublicSnapshot(d.sheet);
      return showTimeStep(d, q.chat_id, q.message_id, user.id, data, pub);
    }
    if (what === "name") {
      data.editing = true;
      return showNameStep(d, q.chat_id, q.message_id, user, data, settings);
    }
    if (what === "ct") {
      data.editing = true;
      return showContactStep(d, q.chat_id, q.message_id, user, data, settings);
    }
    return;
  }

  if (dataStr === "c:ok") {
    if (!(await transitionClientSession(d.db, user.id, "confirm", "saving"))) {
      return answer({ toast: "Бронювання вже обробляється…" });
    }
    await answer({ toast: "Записую бронь…" });
    await editWizard(d, q.chat_id, q.message_id, "⏳ <b>Перевіряю доступність та записую бронь…</b>", { inline_keyboard: [] });

    const { bookings, settings } = await readClientOwnBookings(d.sheet, d.db, user.id, nowMin(d));
    if (bookings.length >= MAX_CLIENT_BOOKINGS) {
      await clearClientSession(d.db, user.id);
      await editWizard(
        d,
        q.chat_id,
        q.message_id,
        `⚠️ У вас уже є <b>${MAX_CLIENT_BOOKINGS}</b> активні броні. Скасуйте одну в «Мої броні», щоб створити нову.`,
        {
          inline_keyboard: [
            [{ text: "📋 Мої броні", callback_data: "c:my" }],
            [{ text: "⬅️ Головне меню", callback_data: "c:menu" }],
          ],
        },
      );
      return;
    }

    const { date, from, to } = intervalToBookingTime(data.startAbs!, data.startAbs! + data.durationMin!);
    const booking: NewBooking = {
      date,
      pcs: data.pcs!,
      from,
      to,
      name: data.name!,
      contact: data.contact!,
      note: CLIENT_NOTE,
    };
    const id = newBookingId(now(d).getTime());

    try {
      const rows = await placeClientBooking(d.sheet, booking, id, settings.pcList, settings.schedule, settings.zones);
      await saveClientBooking(d.db, id, user.id);
      await clearClientSession(d.db, user.id);
      await audit(d.db, {
        user_id: user.id,
        user_name: user.displayName,
        action: "client_book",
        card_id: id,
        details: { rows, pcs: booking.pcs, date: booking.date, from: booking.from, to: booking.to },
      });

      const view = {
        startAbs: data.startAbs!,
        durationMin: data.durationMin!,
        zone: data.zone!,
        pcs: data.pcs!,
        name: data.name!,
        contact: data.contact!,
      };
      await editWizard(
        d,
        q.chat_id,
        q.message_id,
        `✅ <b>Бронь підтверджено!</b>\n\n${clientConfirmDetails(view, settings.pcList)}\n\nЧекаємо на вас у клубі! Нагадаємо за 30 хв до початку.`,
        {
          inline_keyboard: [
            [{ text: "📋 Мої броні", callback_data: "c:my" }],
            [{ text: "🏠 Головне меню", callback_data: "c:menu" }],
          ],
        },
      );
      await notifyAdmins(d, adminNewClientBookingText(view, settings.pcList));
    } catch (err) {
      if (err instanceof BookingConflictError) {
        const zPcs = zonePCs(settings.pcList, settings.zones, data.zone!);
        const slots = findAvailableStartTimes({
          daySerial: data.daySerial!,
          schedule: settings.schedule,
          zonePcs: zPcs,
          count: data.count!,
          bookings: err.busySlots,
          nowAbs: nowMin(d),
          stepMinutes: 60,
          minDurationMinutes: 60,
          preferredPcs: data.preferredPcs,
        });
        const nearest = [...slots]
          .sort((a, b) => Math.abs(a - data.startAbs!) - Math.abs(b - data.startAbs!))
          .slice(0, 8)
          .sort((a, b) => a - b);

        const nextData: ClientWizardData = {
          daySerial: data.daySerial,
          zone: data.zone,
          count: data.count,
          preferredPcs: data.preferredPcs,
          name: data.name,
          contact: data.contact,
        };
        await saveClientSession(d.db, { user_id: user.id, message_id: q.message_id, step: "time", data: nextData });
        const head = headerSummary(nextData, settings.pcList);
        if (nearest.length) {
          await editWizard(
            d,
            q.chat_id,
            q.message_id,
            `${head}\n\n⚠️ <b>На жаль, ці ПК щойно зайняли.</b>\nОберіть найближчий вільний час початку:`,
            clientTimeKeyboard(nearest, data.daySerial!),
          );
        } else {
          await editWizard(
            d,
            q.chat_id,
            q.message_id,
            `${head}\n\n⚠️ <b>На жаль, ці ПК щойно зайняли, і на цей день вільного часу більше немає.</b>`,
            {
              inline_keyboard: [
                [
                  { text: "⬅️ Назад", callback_data: "c:back" },
                  { text: "❌ Скасувати", callback_data: "c:cancel" },
                ],
              ],
            },
          );
        }
        return;
      }

      if (err instanceof BookingOutOfHoursError || err instanceof SheetFullError) {
        await saveClientSession(d.db, { user_id: user.id, message_id: q.message_id, step: "confirm", data });
        await editWizard(
          d,
          q.chat_id,
          q.message_id,
          `⚠️ ${esc(err.message)}`,
          {
            inline_keyboard: [
              [
                { text: "⬅️ Назад", callback_data: "c:back" },
                { text: "🏠 Головне меню", callback_data: "c:menu" },
              ],
            ],
          },
        );
        return;
      }

      await saveClientSession(d.db, { user_id: user.id, message_id: q.message_id, step: "confirm", data });
      throw err;
    }
    return;
  }

  await answer({});
}

export async function onClientText(
  d: Deps,
  msg: { chat_id: number; message_id: number; text: string; chat_type?: string },
  user: ClientUser,
): Promise<void> {
  if ((msg.chat_type ?? "private") !== "private") return;
  const session = await getClientSession(d.db, user.id);
  if (!session || !session.message_id || !["name_input", "phone_input"].includes(session.step)) {
    await d.api.sendMessage(msg.chat_id, "Користуйтесь кнопками меню нижче 👇", {
      reply_markup: clientMainMenuKeyboard(),
    });
    return;
  }

  await d.api.deleteMessage(msg.chat_id, msg.message_id).catch(() => {});
  const data = JSON.parse(session.data) as ClientWizardData;
  const settings = await loadSettings(d.sheet);

  if (session.step === "name_input") {
    const clean = msg.text.trim();
    if (!clean || clean === "-") {
      const head = headerSummary(data, settings.pcList);
      await editWizard(d, msg.chat_id, session.message_id, `${head}\n\n⚠️ Ім'я не може бути порожнім. Напишіть ваше ім'я:`, {
        inline_keyboard: [
          [
            { text: "⬅️ Назад", callback_data: "c:back" },
            { text: "❌ Скасувати", callback_data: "c:cancel" },
          ],
        ],
      });
      return;
    }
    data.name = clean.slice(0, 60);
    if (data.editing && data.contact) {
      data.editing = false;
      return showConfirmStep(d, msg.chat_id, session.message_id, user.id, data, settings);
    }
    return showContactStep(d, msg.chat_id, session.message_id, user, data, settings);
  }

  // session.step === "phone_input"
  const raw = msg.text.trim();
  const digits = raw.replace(/\D/g, "");
  if (!/^\+?[\d\s\-()]+$/.test(raw) || digits.length < 9 || digits.length > 15) {
    return enterPhoneInput(
      d,
      msg.chat_id,
      session.message_id,
      user,
      data,
      settings,
      "⚠️ Некоректний номер телефону. Введіть від 9 до 15 цифр (напр. <code>+48 501 234 567</code>) або поділіться контактом кнопкою нижче:",
    );
  }
  await cleanupPhonePrompt(d, msg.chat_id, data);
  const phone = raw.slice(0, 30);
  data.contact = user.username ? `@${user.username}, ${phone}` : phone;
  data.editing = false;
  return showConfirmStep(d, msg.chat_id, session.message_id, user.id, data, settings);
}

export async function onClientContact(
  d: Deps,
  msg: { chat_id: number; message_id: number; phone_number: string; chat_type?: string },
  user: ClientUser,
): Promise<void> {
  if ((msg.chat_type ?? "private") !== "private") return;
  await d.api.deleteMessage(msg.chat_id, msg.message_id).catch(() => {});
  const session = await getClientSession(d.db, user.id);
  if (!session || !session.message_id || session.step !== "phone_input") return;
  const data = JSON.parse(session.data) as ClientWizardData;
  await cleanupPhonePrompt(d, msg.chat_id, data);
  const raw = msg.phone_number.trim();
  const phone = raw.startsWith("+") ? raw : `+${raw}`;
  data.contact = user.username ? `@${user.username}, ${phone}` : phone;
  data.editing = false;
  const settings = await loadSettings(d.sheet);
  await showConfirmStep(d, msg.chat_id, session.message_id, user.id, data, settings);
}
