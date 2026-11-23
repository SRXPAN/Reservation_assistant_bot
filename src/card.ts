// Текст картки броні і кнопки. Без мережі — перевіряється тестами.

import { pcsInRange, splitIntoRuns, type DurationOption } from "./bookings";
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

/* ───────────── клієнтський інтерфейс (особисті повідомлення) ───────────── */

export const clientMainMenuKeyboard = (): Keyboard => ({
  inline_keyboard: [
    [{ text: "🎮 Забронювати ПК", callback_data: "c:book" }],
    [
      { text: "📋 Мої броні", callback_data: "c:my" },
      { text: "📍 Адреса та графік", callback_data: "c:info" },
    ],
  ],
});

export function clientWelcomeText(): string {
  return [
    "👋 <b>Вітаємо в комп'ютерному клубі!</b>",
    "",
    "Тут ви можете за хвилину забронювати ПК на потрібний час, переглянути свої активні броні або дізнатися графік роботи.",
    "",
    "Оберіть дію нижче:",
  ].join("\n");
}

const WEEKDAY_FULL = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"] as const;

function dayScheduleLine(d: DaySchedule): string {
  if (d.mode === "Цілодобово") return "Цілодобово";
  if (d.mode !== "Години" || d.end <= d.start) return "Вихідний";
  return `${formatHHMM(d.start)} – ${d.end % MIN_PER_DAY === 0 && d.end === MIN_PER_DAY ? "00:00" : formatHHMM(d.end)}`;
}

export function clientInfoText(settings: CardSettings): string {
  // Групуємо сусідні дні з однаковим графіком, напр. Пн–Ср: 12:00 – 00:00.
  const groups: { from: number; to: number; label: string }[] = [];
  settings.schedule.forEach((d, idx) => {
    const label = dayScheduleLine(d);
    const prev = groups.at(-1);
    if (prev && prev.label === label) prev.to = idx;
    else groups.push({ from: idx, to: idx, label });
  });
  const schedLines = groups.map((g) => {
    const days = g.from === g.to ? WEEKDAY_FULL[g.from] : `${WEEKDAY_FULL[g.from]}–${WEEKDAY_FULL[g.to]}`;
    return `• <b>${days}:</b> ${g.label}`;
  });

  const zoneCounts = new Map<string, number>();
  for (const pc of settings.pcList) {
    const z = (settings.zones[pc] ?? "").trim() || "Загальна";
    zoneCounts.set(z, (zoneCounts.get(z) ?? 0) + 1);
  }
  const zoneLines = [...zoneCounts.entries()].map(([z, n]) => `• ${esc(z)}: ${n} ПК`);

  return [
    "📍 <b>Графік роботи та зони клубу</b>",
    "",
    "🕒 <b>Години роботи:</b>",
    ...schedLines,
    "",
    "💻 <b>Ігрові зони:</b>",
    ...zoneLines,
  ].join("\n");
}

const shortDayDate = (serial: number) => {
  const { d, m } = serialToDate(serial);
  return `${cap(WEEKDAY_SHORT[weekdayIndex(serial)]!)} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
};

export function clientDateKeyboard(todaySerial: number, calTodaySerial: number, schedule: DaySchedule[]): Keyboard {
  const days = Array.from({ length: 7 }, (_, i) => todaySerial + i);
  const label = (day: number) => {
    const w = windowOf(schedule, day);
    const closed = w.end <= w.start;
    const base = shortDayDate(day);
    let text: string;
    if (day < calTodaySerial) text = `Зараз · ніч (${base})`;
    else if (day === calTodaySerial) text = `Сьогодні (${base})`;
    else if (day === calTodaySerial + 1) text = `Завтра (${base})`;
    else text = base;
    return closed ? `🔒 ${text}` : text;
  };
  const buttons: Button[] = days.map((day) => ({ text: label(day), callback_data: `c:d:${day}` }));
  const rows: Button[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([
    { text: "⬅️ Назад", callback_data: "c:menu" },
    { text: "❌ Скасувати", callback_data: "c:cancel" },
  ]);
  return { inline_keyboard: rows };
}

export function clientZoneKeyboard(zones: string[]): Keyboard {
  const icon = (z: string) => {
    const low = z.toLowerCase();
    if (low.includes("stream")) return "🎙";
    if (low.includes("reg")) return "🖥";
    return "💻";
  };
  const rows: Button[][] = [
    zones.map((z, idx) => ({ text: `${icon(z)} ${z}`, callback_data: `c:z:${idx}` })),
    [
      { text: "⬅️ Назад", callback_data: "c:back" },
      { text: "❌ Скасувати", callback_data: "c:cancel" },
    ],
  ];
  return { inline_keyboard: rows };
}

export function clientCountKeyboard(zonePcsCount: number, maxPcs = 5): Keyboard {
  const limit = Math.min(maxPcs, zonePcsCount);
  const countBtns: Button[] = Array.from({ length: limit }, (_, i) => ({
    text: `${i + 1} ПК`,
    callback_data: `c:n:${i + 1}`,
  }));
  const rows: Button[][] = [];
  if (countBtns.length) rows.push(countBtns.slice(0, 3));
  if (countBtns.length > 3) rows.push(countBtns.slice(3));
  if (zonePcsCount > maxPcs) {
    rows.push([{ text: "👥 Більше 5 (зв'язок з адміном)", callback_data: "c:more" }]);
  }
  rows.push([{ text: "🔢 Обрати конкретні номери ПК", callback_data: "c:pick" }]);
  rows.push([
    { text: "⬅️ Назад", callback_data: "c:back" },
    { text: "❌ Скасувати", callback_data: "c:cancel" },
  ]);
  return { inline_keyboard: rows };
}

export function clientPickPcsKeyboard(availablePcs: number[], selected: number[]): Keyboard {
  const selSet = new Set(selected);
  const rows: Button[][] = [];
  for (let i = 0; i < availablePcs.length; i += 5) {
    rows.push(
      availablePcs.slice(i, i + 5).map((pc) => ({
        text: selSet.has(pc) ? `✅ ${pc}` : `${pc}`,
        callback_data: `c:pc:${pc}`,
      })),
    );
  }
  if (selected.length > 0) {
    rows.push([{ text: `➡️ Далі (${selected.length} ПК)`, callback_data: "c:pcok" }]);
  }
  rows.push([
    { text: "⬅️ Назад", callback_data: "c:back" },
    { text: "❌ Скасувати", callback_data: "c:cancel" },
  ]);
  return { inline_keyboard: rows };
}

export function clientTimeKeyboard(slots: number[], daySerial: number): Keyboard {
  const nextMidnight = (daySerial + 1) * MIN_PER_DAY;
  const rows: Button[][] = [];
  for (let i = 0; i < slots.length; i += 4) {
    rows.push(
      slots.slice(i, i + 4).map((t) => ({
        text: t >= nextMidnight ? `${formatHHMM(t)} 🌙` : formatHHMM(t),
        callback_data: `c:t:${t}`,
      })),
    );
  }
  rows.push([
    { text: "⬅️ Назад", callback_data: "c:back" },
    { text: "❌ Скасувати", callback_data: "c:cancel" },
  ]);
  return { inline_keyboard: rows };
}

export function clientDurationKeyboard(options: DurationOption[]): Keyboard {
  const buttons: Button[] = options.map((opt) => {
    let text: string;
    if (opt.toClose && opt.minutes % 60 === 0 && opt.minutes <= 300) {
      text = `${opt.minutes / 60} год · до закриття`;
    } else if (opt.toClose) {
      text = `До закриття (${durationLabel(opt.minutes)})`;
    } else {
      text = durationLabel(opt.minutes);
    }
    return { text, callback_data: `c:dur:${opt.minutes}` };
  });
  const rows: Button[][] = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  rows.push([
    { text: "⬅️ Назад", callback_data: "c:back" },
    { text: "❌ Скасувати", callback_data: "c:cancel" },
  ]);
  return { inline_keyboard: rows };
}

export function clientNameKeyboard(tgName: string): Keyboard {
  const rows: Button[][] = [];
  if (tgName.trim()) {
    rows.push([{ text: `👤 Записати як: ${tgName.trim().slice(0, 32)}`, callback_data: "c:nm:tg" }]);
  }
  rows.push([{ text: "✏️ Ввести інше ім'я", callback_data: "c:nm:edit" }]);
  rows.push([
    { text: "⬅️ Назад", callback_data: "c:back" },
    { text: "❌ Скасувати", callback_data: "c:cancel" },
  ]);
  return { inline_keyboard: rows };
}

export function clientContactKeyboard(hasUsername: boolean): Keyboard {
  const rows: Button[][] = [];
  if (hasUsername) {
    rows.push([{ text: "➡️ Продовжити без телефону", callback_data: "c:ct:skip" }]);
    rows.push([{ text: "📱 Додати номер телефону", callback_data: "c:ct:phone" }]);
  }
  rows.push([
    { text: "⬅️ Назад", callback_data: "c:back" },
    { text: "❌ Скасувати", callback_data: "c:cancel" },
  ]);
  return { inline_keyboard: rows };
}

export interface ClientConfirmView {
  startAbs: number;
  durationMin: number;
  zone: string;
  pcs: number[];
  name: string;
  contact: string;
}

export function clientConfirmDetails(v: ClientConfirmView, pcList: number[]): string {
  const dateSerial = Math.floor(v.startAbs / MIN_PER_DAY);
  const endAbs = v.startAbs + v.durationMin;
  const endSerial = Math.floor((endAbs - 1) / MIN_PER_DAY);
  const over = endSerial > dateSerial;
  const endStr = endAbs % MIN_PER_DAY === 0 ? "24:00" : formatHHMM(endAbs);
  const nextDay = over ? ` (до ${WEEKDAY_SHORT[weekdayIndex(dateSerial + 1)]})` : "";
  return [
    `📅 <b>Дата:</b> ${dateLabel(dateSerial)}`,
    `🕒 <b>Час:</b> ${formatHHMM(v.startAbs)} – ${endStr}${nextDay} · ${durationLabel(v.durationMin)}`,
    `💻 <b>ПК:</b> ${pcsLabel(v.pcs, pcList)} (${esc(v.zone)})`,
    `👤 <b>Ім'я:</b> ${esc(v.name)}`,
    `📞 <b>Контакт:</b> ${esc(v.contact)}`,
  ].join("\n");
}

export const clientConfirmKeyboard = (): Keyboard => ({
  inline_keyboard: [
    [{ text: "✅ Підтвердити бронь", callback_data: "c:ok" }],
    [
      { text: "✏️ Змінити", callback_data: "c:edit" },
      { text: "❌ Скасувати", callback_data: "c:cancel" },
    ],
  ],
});

export const clientEditMenuKeyboard = (): Keyboard => ({
  inline_keyboard: [
    [
      { text: "📅 Дата", callback_data: "c:ed:date" },
      { text: "💻 Зона / ПК", callback_data: "c:ed:zone" },
      { text: "🕒 Час", callback_data: "c:ed:time" },
    ],
    [
      { text: "👤 Ім'я", callback_data: "c:ed:name" },
      { text: "📞 Контакт", callback_data: "c:ed:ct" },
    ],
    [{ text: "⬅️ Назад до перевірки", callback_data: "c:ed:back" }],
  ],
});

export function adminNewClientBookingText(v: ClientConfirmView, pcList: number[]): string {
  const dateSerial = Math.floor(v.startAbs / MIN_PER_DAY);
  const endAbs = v.startAbs + v.durationMin;
  const when = `${formatHHMM(v.startAbs)}–${endAbs % MIN_PER_DAY === 0 ? "24:00" : formatHHMM(endAbs)}`;
  return `🆕 Нова бронь від клієнта: ${shortDayDate(dateSerial)} · ${when} · ${pcsLabel(v.pcs, pcList)} (${esc(v.zone)}) · ${esc(v.name)} (${esc(v.contact)})`;
}

export function adminClientCancelledText(p: { date: number; start: number; end: number; pcs: number[]; name: string }, pcList: number[]): string {
  const when = `${formatHHMM(p.start)}–${p.end % MIN_PER_DAY === 0 ? "24:00" : formatHHMM(p.end)}`;
  return `🗑 Клієнт скасував бронь: ${shortDayDate(p.date)} · ${when} · ${pcsLabel(p.pcs, pcList)} · ${esc(p.name || "без імені")}`;
}
