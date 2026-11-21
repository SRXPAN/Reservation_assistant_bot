// Текст картки броні і кнопки. Без мережі — перевіряється тестами.

import { pcsInRange, splitIntoRuns } from "./bookings";
import type { Check } from "./check";
import { hasWarnings } from "./check";
import { windowOf, type DaySchedule } from "./hours";
import { WEEKDAY_SHORT, type Draft } from "./parse";
import { MIN_PER_DAY, formatDate, formatHHMM, serialToDate, weekdayIndex } from "./time";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface CardSettings {
  pcList: number[];
  zones: Record<number, string>;
  schedule: DaySchedule[];
}

/** «12–17», «12, 14, 16», «12–14, 16». */
export function pcsLabel(pcs: number[], pcList: number[]): string {
  const runs = splitIntoRuns(pcs, pcList);
  const valid = runs.length ? runs : pcs.map((p) => ({ first: p, last: p }));
  const text = valid.map((r) => (r.first === r.last ? `${r.first}` : `${r.first}–${r.last}`)).join(", ");
  const count = runs.reduce((n, r) => n + pcsInRange(pcList, r.first, r.last).length, 0) || pcs.length;
  return `ПК ${text}${count > 1 ? ` (${count} ПК)` : ""}`;
}

export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} хв`;
  return m ? `${h} год ${m} хв` : `${h} год`;
}

const dateLabel = (serial: number) => `${cap(WEEKDAY_SHORT[weekdayIndex(serial)]!)} ${formatDate(serial)}`;

function hoursLabel(schedule: DaySchedule[], date: number): string {
  const w = windowOf(schedule, date);
  if (w.end === w.start) return `${WEEKDAY_SHORT[weekdayIndex(date)]} — вихідний`;
  return `${WEEKDAY_SHORT[weekdayIndex(date)]} ${formatHHMM(w.start)}–${formatHHMM(w.end)}`;
}

/** Рядки з полями броні (без заголовка і підсумку). */
export function fieldsBlock(d: Draft, s: CardSettings): string[] {
  const lines: string[] = [];
  lines.push(`📅 ${d.date === null ? "—" : dateLabel(d.date)}`);
  if (d.pcs.length) {
    const zones = [...new Set(d.pcs.map((pc) => s.zones[pc]).filter(Boolean))];
    lines.push(`💻 ${pcsLabel(d.pcs, s.pcList)}${zones.length ? " · " + zones.join(" + ") : ""}`);
  } else lines.push("💻 —");
  if (d.from !== null && d.to !== null) {
    const over = d.to <= d.from;
    const minutes = d.to - d.from + (over ? MIN_PER_DAY : 0);
    const nextDay = over && d.date !== null ? ` (до ${WEEKDAY_SHORT[weekdayIndex(d.date + 1)]})` : over ? " (наступного дня)" : "";
    lines.push(`🕒 ${formatHHMM(d.from)} – ${d.to === MIN_PER_DAY ? "24:00" : formatHHMM(d.to)}${nextDay} · ${durationLabel(minutes)}`);
  } else {
    lines.push(`🕒 ${d.from === null ? "—" : formatHHMM(d.from)} – ${d.to === null ? "—" : formatHHMM(d.to)}`);
  }
  lines.push(`👤 ${d.name ? esc(d.name) : "—"}${d.contact ? " · " + esc(d.contact) : ""}`);
  if (d.note) lines.push(`📝 ${esc(d.note)}`);
  return lines;
}

/** Підсумок перевірки. */
export function checkBlock(d: Draft, c: Check, s: CardSettings): string[] {
  const lines: string[] = [];
  if (c.missing.length) lines.push(`⚠ Не вистачає: ${c.missing.join(", ")}`);
  if (c.conflicts.length) {
    lines.push("⚠ <b>Накладка</b>");
    for (const x of c.conflicts) {
      const b = x.booking;
      const other = b.date !== d.date ? ` (${formatDate(b.date)})` : "";
      const who = `${esc(b.name || "без імені")}${b.hi > b.lo ? ` (група ПК ${b.lo}–${b.hi})` : ""}`;
      const verb = x.pcs.length > 1 ? "зайняті" : "зайнятий";
      lines.push(`ПК ${x.pcs.join(", ")} ${verb}: ${who} ${formatHHMM(b.from)}–${formatHHMM(b.to)}${other}`);
    }
  }
  if (c.outOfHours && d.date !== null) lines.push(`⏰ Поза годинами роботи (${hoursLabel(s.schedule, d.date)})`);
  if (c.past) lines.push("🕓 Цей час уже минув");
  for (const h of d.hints) lines.push(`ℹ️ ${esc(h)}`);
  if (!c.missing.length && !hasWarnings(c)) lines.unshift("✅ Вільно");
  return lines;
}

/* ───────────── кнопки ───────────── */

export type Button = { text: string; callback_data: string } | { text: string; url: string };
export type Keyboard = { inline_keyboard: Button[][] };

const cb = (text: string, act: string, id: string): Button => ({ text, callback_data: `${act}|${id}` });

/** Головні кнопки чернетки (нова бронь або зміна записаної). */
export function draftKeyboard(id: string, c: Check, editingSaved: boolean): Keyboard {
  const cancel = editingSaved ? cb("↩️ Не змінювати", "u", id) : cb("❌ Відміна", "c", id);
  if (c.missing.length) return { inline_keyboard: [[cb("✏️ Доповнити", "e", id), cancel]] };
  const save = editingSaved ? "💾 Зберегти зміни" : "✅ Записати";
  if (hasWarnings(c)) {
    const what = c.conflicts.length ? "накладку" : c.outOfHours ? "години роботи" : "минулий час";
    return {
      inline_keyboard: [[cb(`⚠ ${editingSaved ? "Зберегти" : "Записати"} попри ${what}`, "w", id)], [cb("✏️ Змінити", "e", id), cancel]],
    };
  }
  return { inline_keyboard: [[cb(save, "s", id), cb("✏️ Змінити", "e", id), cancel]] };
}

export const confirmKeyboard = (id: string): Keyboard => ({
  inline_keyboard: [[cb("✅ Так, записати", "f", id)], [cb("↩️ Назад", "b", id)]],
});

export const fieldsKeyboard = (id: string): Keyboard => ({
  inline_keyboard: [
    [cb("📅 Дата", "p:date", id), cb("💻 ПК", "p:pcs", id), cb("🕒 Час", "p:time", id)],
    [cb("👤 Ім'я", "p:name", id), cb("📞 Контакт", "p:contact", id), cb("📝 Примітка", "p:note", id)],
    [cb("↩️ Назад", "b", id)],
  ],
});

export const savedKeyboard = (id: string, sheetUrl: string): Keyboard => ({
  inline_keyboard: [[cb("✏️ Змінити", "e", id), cb("🗑 Скасувати бронь", "d", id)], [{ text: "📄 Таблиця", url: sheetUrl }]],
});

export const deleteKeyboard = (id: string): Keyboard => ({
  inline_keyboard: [[cb("🗑 Так, скасувати бронь", "D", id)], [cb("↩️ Назад", "b", id)]],
});

/** Таблиця не відповіла під час перевірки — спробувати ще раз. */
export const retryKeyboard = (id: string): Keyboard => ({
  inline_keyboard: [[cb("🔄 Перевірити ще раз", "k", id)], [cb("❌ Відміна", "c", id)]],
});

/** Броні в таблиці немає (видалили вручну): записати заново або закрити картку. */
export const missingKeyboard = (id: string): Keyboard => ({
  inline_keyboard: [[cb("➕ Записати заново", "R", id)], [cb("✖️ Закрити картку", "X", id)]],
});

/** «Бронь кнопками», крок 1: дата на тиждень уперед. */
export function dateKeyboard(id: string, today: number): Keyboard {
  const days = Array.from({ length: 7 }, (_, i) => today + i);
  const label = (day: number, i: number) => {
    if (i === 0) return "Сьогодні";
    if (i === 1) return "Завтра";
    const { d, m } = serialToDate(day);
    return `${cap(WEEKDAY_SHORT[weekdayIndex(day)]!)} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
  };
  const buttons = days.map((day, i) => cb(label(day, i), `nd:${day}`, id));
  return {
    inline_keyboard: [buttons.slice(0, 3), buttons.slice(3, 7), [cb("📅 Інша дата", "nd:x", id), cb("❌ Відміна", "c", id)]],
  };
}

/** Під час покрокового введення — лише «Відміна». */
export const cancelOnlyKeyboard = (id: string): Keyboard => ({ inline_keyboard: [[cb("❌ Відміна", "c", id)]] });

/** Закріплене меню гілки. */
export const menuKeyboard = (sheetUrl: string): Keyboard => ({
  inline_keyboard: [
    [
      { text: "📅 Сьогодні", callback_data: "m:today" },
      { text: "📅 Завтра", callback_data: "m:tomorrow" },
    ],
    [
      { text: "🟢 Вільні зараз", callback_data: "m:free" },
      { text: "🔎 Пошук", callback_data: "m:search" },
    ],
    [
      { text: "➕ Бронь кнопками", callback_data: "m:new" },
      { text: "📄 Таблиця", url: sheetUrl },
    ],
  ],
});

export const FIELD_PROMPTS: Record<string, { label: string; ask: string; placeholder: string }> = {
  date: { label: "дату", ask: "нову дату", placeholder: "21.11, завтра, пт" },
  pcs: { label: "ПК", ask: "ПК", placeholder: "12-17 або 12, 14, 16" },
  time: { label: "час", ask: "час", placeholder: "19-2 або з 20:00 на 3 години" },
  name: { label: "ім'я", ask: "ім'я клієнта", placeholder: "Андрій" },
  contact: { label: "контакт", ask: "контакт", placeholder: "+48 …, tg, insta" },
  note: { label: "примітку", ask: "примітку («-» — прибрати)", placeholder: "день народження" },
  search: { label: "пошук", ask: "ім'я або телефон для пошуку", placeholder: "Андрій або 501 234" },
};

/** «Бронь кнопками»: який крок після якого і що підказати в картці. */
export const WIZARD_NEXT: Record<string, string | null> = { date: "pcs", pcs: "time", time: "name", name: "contact", contact: null };
export const WIZARD_HINT: Record<string, string> = {
  pcs: "👉 Напишіть ПК у відповідь на запит нижче",
  time: "👉 Напишіть час",
  name: "👉 Напишіть ім'я клієнта",
  contact: "👉 Напишіть контакт (або «-», якщо немає)",
};
