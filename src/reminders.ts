// Виконання плану нагадувань (Cron) і кнопки [✅ Прийшов] [❌ Не прийшов].

import { complete } from "./bookings";
import { esc } from "./card";
import { isAdmin } from "./config";
import type { Deps, Who } from "./flow";
import { safeError } from "./log";
import {
  clientReminderText,
  planClientReminders,
  planNotifications,
  reminderText,
  withAttendance,
  withClientConfirm,
  type Action,
} from "./notify";
import { readSnapshot, updateNotes } from "./sheet";
import { audit, getAdminChannel, getAuthorizedClientBooking, listActiveClientBookingOwners } from "./store";
import { formatHHMM, nowAbs, serialToDate, zonedNow } from "./time";
import { dayView, toEntries } from "./views";

/** Ключі, старші за це, нікому не потрібні (броні вже минули). */
const KEEP_DAYS = 14;

const attendanceKeyboard = (id: number) => ({
  inline_keyboard: [
    [
      { text: "✅ Прийшов", callback_data: `a:y|${id}` },
      { text: "❌ Не прийшов", callback_data: `a:n|${id}` },
    ],
  ],
});

/** Застовпити ключ до відправки: true — ми перші (дублів не буде навіть при двох запусках Cron одночасно). */
async function claim(db: D1Database, a: Action, extra: { booking_id?: string | null; target?: string | null; text?: string | null }) {
  const res = await db
    .prepare("INSERT OR IGNORE INTO sent_reminders (key, kind, booking_id, target, text) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(a.key, a.kind, extra.booking_id ?? null, extra.target ?? null, extra.text ?? null)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export interface RunResult {
  sent: number;
  failed: number;
  skipped?: string;
}

/** Надіслати все, що належить на зараз. Викликається з Cron кожні 5 хв (і /run-check). */
export async function runReminders(d: Deps): Promise<RunResult> {
  const binding = await getAdminChannel(d.db, d.env);
  if (!binding) return { sent: 0, failed: 0, skipped: "гілку не прив'язано" };
  const tz = d.env.TZ || "Europe/Warsaw";
  const now = nowAbs(tz, d.now ? d.now() : new Date());

  const snap = await readSnapshot(d.sheet);
  const entries = toEntries(snap.bookings, snap.settings.pcList);
  const { results } = await d.db
    .prepare("SELECT key FROM sent_reminders WHERE created_at > datetime('now', ?1)")
    .bind(`-${KEEP_DAYS} days`)
    .all<{ key: string }>();
  const sentSet = new Set(results.map((r) => r.key));
  const actions = planNotifications({
    entries,
    schedule: snap.settings.schedule,
    firstHour: snap.settings.firstHour,
    now,
    sent: sentSet,
  });

  let sent = 0;
  let failed = 0;
  for (const a of actions) {
    let text: string;
    let extra: { booking_id?: string | null; target?: string | null; text?: string | null } = {};
    if (a.kind === "summary") {
      text = dayView(entries, snap.settings, a.day, "Сьогодні") + (a.late ? `\n\n<i>Зведення із запізненням (відкриття о ${formatHHMM(a.at)})</i>` : "");
    } else {
      text = reminderText(a, snap.settings.pcList);
      const e = a.entry;
      extra = {
        booking_id: e.id || null,
        target: e.id ? null : JSON.stringify({ date: e.date, start: e.start, lo: e.pcs[0], hi: e.pcs.at(-1), name: e.name }),
        text,
      };
    }
    if (!(await claim(d.db, a, extra))) continue;
    try {
      const row = await d.db.prepare("SELECT id FROM sent_reminders WHERE key = ?1").bind(a.key).first<{ id: number }>();
      const msg = await d.api.sendMessage(binding.chat_id, text, {
        parse_mode: "HTML",
        message_thread_id: binding.thread_id ?? undefined,
        link_preview_options: { is_disabled: true },
        reply_markup: a.kind === "reminder" ? attendanceKeyboard(row!.id) : undefined,
      });
      await d.db.prepare("UPDATE sent_reminders SET chat_id = ?2, message_id = ?3 WHERE key = ?1").bind(a.key, binding.chat_id, msg.message_id).run();
      sent++;
    } catch (err) {
      // Не вдалося — звільняємо ключ, наступний запуск спробує ще раз.
      console.error("Нагадування не надіслано", a.kind, a.kind === "reminder" ? a.entry.id || "manual" : a.day, safeError(err));
      await d.db.prepare("DELETE FROM sent_reminders WHERE key = ?1").bind(a.key).run();
      failed++;
    }
  }

  // Особисті нагадування клієнтам у ЛС за 30 хв до початку.
  const botIds = [...new Set(entries.map((e) => e.id).filter(Boolean))];
  const clientOwners = await listActiveClientBookingOwners(d.db, botIds);
  const clientActions = planClientReminders({ entries, clientOwners, now, sent: sentSet });
  for (const ca of clientActions) {
    const text = clientReminderText(ca, snap.settings.pcList);
    const res = await d.db
      .prepare("INSERT OR IGNORE INTO sent_reminders (key, kind, booking_id, text) VALUES (?1, 'reminder', ?2, ?3)")
      .bind(ca.key, ca.entry.id, text)
      .run();
    if ((res.meta.changes ?? 0) !== 1) continue;
    try {
      const msg = await d.api.sendMessage(ca.clientTgId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: clientReminderKeyboard(ca.entry.id),
      });
      await d.db.prepare("UPDATE sent_reminders SET chat_id = ?2, message_id = ?3 WHERE key = ?1").bind(ca.key, ca.clientTgId, msg.message_id).run();
      sent++;
    } catch (err) {
      console.error("Клієнтське нагадування не надіслано", ca.entry.id, safeError(err));
      if (!String(err).includes("403")) {
        await d.db.prepare("DELETE FROM sent_reminders WHERE key = ?1").bind(ca.key).run();
      }
      failed++;
    }
  }

  await d.db.prepare("DELETE FROM sent_reminders WHERE created_at < datetime('now', ?1)").bind(`-${KEEP_DAYS} days`).run();
  return { sent, failed };
}

export const clientReminderKeyboard = (bookingId: string) => ({
  inline_keyboard: [
    [
      { text: "👍 Буду вчасно", callback_data: `c:rem:ok:${bookingId}` },
      { text: "❌ Скасувати бронь", callback_data: `c:rem:can:${bookingId}` },
    ],
  ],
});

interface ReminderRow {
  id: number;
  booking_id: string | null;
  target: string | null;
  text: string | null;
  chat_id: number | null;
  message_id: number | null;
}

/** [✅ Прийшов] / [❌ Не прийшов]: дописати відмітку в примітку броні і в повідомлення. */
export async function onAttendance(
  d: Deps,
  q: { came: boolean; reminderId: number; chat_id: number; message_id: number },
  who: Who,
  answer: (r: { toast?: string; alert?: boolean }) => Promise<void>,
): Promise<void> {
  if (!isAdmin(who.id, d.env)) return answer({ toast: "Немає доступу." });
  const r = await d.db.prepare("SELECT * FROM sent_reminders WHERE id = ?1").bind(q.reminderId).first<ReminderRow>();
  if (!r || r.chat_id !== q.chat_id || r.message_id !== q.message_id) return answer({ toast: "Нагадування застаріло" });
  await answer({ toast: "Записую в таблицю…" });

  const z = zonedNow(d.env.TZ || "Europe/Warsaw", d.now ? d.now() : new Date());
  const { d: day, m } = serialToDate(z.serial);
  const at = `${formatHHMM(z.minutes)}`;
  const stamp = `${String(day).padStart(2, "0")}.${String(m).padStart(2, "0")} ${at}`;
  const target = r.target ? (JSON.parse(r.target) as { date: number; start: number; lo: number; hi: number; name: string }) : null;

  let rows: number[] = [];
  let error: string | null = null;
  try {
    rows = await updateNotes(
      d.sheet,
      (bookings) =>
        bookings.filter((b) => {
          if (r.booking_id) return b.botId === r.booking_id;
          const c = complete(b);
          return !!c && !!target && c.start === target.start && c.lo === target.lo && c.hi === target.hi && c.name === target.name;
        }),
      (note) => withAttendance(note, q.came, who.name, at),
    );
    if (!rows.length) error = "Броні в таблиці вже немає — відмітку не записано";
  } catch (err) {
    error = `Не вдалося записати відмітку: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (!error) {
    await d.db
      .prepare("UPDATE sent_reminders SET attendance = ?2, marked_by = ?3, marked_at = ?4 WHERE id = ?1")
      .bind(r.id, q.came ? "came" : "no_show", who.name, stamp)
      .run();
  }
  const status = error ? `❗ ${esc(error)}` : `${q.came ? "✅ Прийшов" : "❌ Не прийшов"} — відмітив ${esc(who.name)}, ${stamp}`;
  await d.api
    .editMessageText(q.chat_id, q.message_id, `${r.text ?? ""}\n\n${status}`, {
      parse_mode: "HTML",
      reply_markup: attendanceKeyboard(r.id), // можна передумати і натиснути іншу кнопку
      link_preview_options: { is_disabled: true },
    })
    .catch((err) => {
      if (!String(err).includes("message is not modified")) throw err;
    });
  await audit(d.db, {
    user_id: who.id,
    user_name: who.name,
    action: error ? "attendance_error" : q.came ? "came" : "no_show",
    card_id: r.booking_id,
    details: error ?? { rows },
  });
}

/** Кнопка клієнта [👍 Буду вчасно] у ЛС: дописати в колонку H «клієнт підтвердив (HH:MM)». */
export async function onClientReminderConfirm(
  d: Deps,
  bookingId: string,
  q: { chat_id: number; message_id: number },
  who: Who,
  answer: (r: { toast?: string; alert?: boolean }) => Promise<void>,
): Promise<void> {
  const owner = await getAuthorizedClientBooking(d.db, bookingId, who.id, d.env);
  if (!owner) {
    await answer({ toast: "Бронь недоступна." });
    return;
  }
  await answer({ toast: "Підтверджую…" });

  const z = zonedNow(d.env.TZ || "Europe/Warsaw", d.now ? d.now() : new Date());
  const at = formatHHMM(z.minutes);

  let rows: number[] = [];
  let error: string | null = null;
  try {
    rows = await updateNotes(
      d.sheet,
      (bookings) => bookings.filter((b) => b.botId === bookingId),
      (note) => withClientConfirm(note, at),
    );
    if (!rows.length) error = "Броні в таблиці вже немає.";
  } catch (err) {
    error = `Не вдалося оновити: ${err instanceof Error ? err.message : String(err)}`;
  }

  const savedRow = await d.db
    .prepare("SELECT text FROM sent_reminders WHERE chat_id = ?1 AND message_id = ?2")
    .bind(q.chat_id, q.message_id)
    .first<{ text: string | null }>();
  const baseText = savedRow?.text ?? "⏰ Нагадування про вашу бронь";

  const statusLine = error ? `❗ ${esc(error)}` : `👍 Підтверджено о ${at}! Чекаємо на вас.`;
  const markup = error
    ? { inline_keyboard: [] }
    : { inline_keyboard: [[{ text: "❌ Скасувати бронь", callback_data: `c:rem:can:${bookingId}` }]] };

  await d.api
    .editMessageText(q.chat_id, q.message_id, `${baseText}\n\n${statusLine}`, {
      parse_mode: "HTML",
      reply_markup: markup,
      link_preview_options: { is_disabled: true },
    })
    .catch((err) => {
      if (!String(err).includes("message is not modified")) throw err;
    });

  await audit(d.db, {
    user_id: who.id,
    user_name: who.name,
    action: error ? "attendance_error" : "client_confirm",
    card_id: bookingId,
    details: error ?? { rows, at },
  });
}
