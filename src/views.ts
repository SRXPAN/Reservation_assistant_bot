// Списки для меню: «Сьогодні / Завтра», «Вільні зараз», «Пошук». Без мережі — перевіряються тестами.

import { complete, pcsInRange, type SheetBooking } from "./bookings";
import { esc, pcsLabel } from "./card";
import { openWindowAt, windowOf, type DaySchedule } from "./hours";
import { WEEKDAY_SHORT } from "./parse";
import { MIN_PER_DAY, formatHHMM, serialToDate, weekdayIndex } from "./time";

export interface ViewSettings {
  pcList: number[];
  schedule: DaySchedule[];
}

/** Бронь для показу: рядки з однаковим ID бота злиті в одну (несуміжні ПК). */
export interface Entry {
  id: string;
  rows: number[];
  date: number;
  start: number;
  end: number;
  pcs: number[];
  name: string;
  contact: string;
  note: string;
  statuses: string[];
}

export function toEntries(bookings: SheetBooking[], pcList: number[]): Entry[] {
  const byId = new Map<string, Entry>();
  const out: Entry[] = [];
  for (const raw of bookings) {
    const b = complete(raw);
    if (!b) continue;
    const pcs = pcsInRange(pcList, b.lo, b.hi);
    const existing = b.botId ? byId.get(b.botId) : undefined;
    if (existing) {
      existing.rows.push(b.row);
      existing.pcs = [...new Set([...existing.pcs, ...pcs])].sort((x, y) => x - y);
      existing.statuses.push(b.status);
      continue;
    }
    const e: Entry = {
      id: b.botId,
      rows: [b.row],
      date: b.date,
      start: b.start,
      end: b.end,
      pcs: pcs.length ? pcs : [b.lo],
      name: b.name,
      contact: b.contact,
      note: b.note,
      statuses: [b.status],
    };
    if (b.botId) byId.set(b.botId, e);
    out.push(e);
  }
  return out.sort((a, b) => a.start - b.start || a.pcs[0]! - b.pcs[0]!);
}

/** Робочий день, до якого належить момент: нічна година 01:00 у пт — це ще четвер. */
export function businessDay(schedule: DaySchedule[], abs: number): number {
  return openWindowAt(schedule, abs)?.day ?? Math.floor(abs / MIN_PER_DAY);
}

const dayTitle = (serial: number) => {
  const { d, m } = serialToDate(serial);
  return `${WEEKDAY_SHORT[weekdayIndex(serial)]} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
};

function hoursText(schedule: DaySchedule[], day: number): string {
  const w = windowOf(schedule, day);
  return w.end === w.start ? "вихідний" : `${formatHHMM(w.start)}–${formatHHMM(w.end)}`;
}

/** Позначка статусу з колонки K. */
export function statusMark(statuses: string[]): string {
  if (statuses.some((s) => s.startsWith("⚠ НАКЛАДКА"))) return " ⚠ накладка";
  if (statuses.some((s) => s.startsWith("⏰"))) return " ⏰ поза годинами";
  if (statuses.some((s) => s.startsWith("⚠"))) return " ⚠ перевірте рядок";
  return "";
}

function line(e: Entry, pcList: number[], withDate = false): string {
  const when = `${formatHHMM(e.start)}–${formatHHMM(e.end)}`;
  const date = withDate ? `${dayTitle(e.date)} ` : "";
  const who = `${esc(e.name || "без імені")}${e.contact ? " · " + esc(e.contact) : ""}`;
  return `${date}${when} · ${pcsLabel(e.pcs, pcList)} · ${who}${statusMark(e.statuses)}`;
}

const MAX_LINES = 60;

function clip(lines: string[]): string[] {
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… і ще ${lines.length - MAX_LINES}`] : lines;
}

/** «📅 Сьогодні / Завтра»: броні робочого дня за часом. */
export function dayView(entries: Entry[], s: ViewSettings, day: number, title: string): string {
  const list = entries.filter((e) => businessDay(s.schedule, e.start) === day);
  const head = `📅 <b>${title} · ${dayTitle(day)}</b> (${hoursText(s.schedule, day)}) — ${countLabel(list.length)}`;
  if (!list.length) return `${head}\n\nБронювань немає.`;
  return [head, "", ...clip(list.map((e) => line(e, s.pcList)))].join("\n");
}

export function countLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? "бронювання" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "бронювання" : "бронювань";
  return `${n} ${word}`;
}

/** Компактний список ПК: «1–4, 6, 8–11». */
function pcRuns(pcs: number[], pcList: number[]): string {
  return pcsLabel(pcs, pcList).replace(/^ПК /, "").replace(/ \(\d+ ПК\)$/, "");
}

/** «🟢 Вільні зараз»: які ПК вільні і до котрої; які зайняті і до котрої. */
export function freeNowView(entries: Entry[], s: ViewSettings, now: number): string {
  const window = openWindowAt(s.schedule, now);
  if (!window) {
    let next: number | null = null;
    for (let day = Math.floor(now / MIN_PER_DAY); day <= Math.floor(now / MIN_PER_DAY) + 7 && next === null; day++) {
      const w = windowOf(s.schedule, day);
      if (w.end > w.start && w.start > now) next = w.start;
    }
    return `🔒 Клуб зараз зачинений.${next !== null ? ` Відкриття: ${dayTitle(Math.floor(next / MIN_PER_DAY))} о ${formatHHMM(next)}.` : ""}`;
  }

  const free = new Map<string, number[]>();
  const busy = new Map<string, { label: string; pcs: number[] }>();
  const tomorrow = (Math.floor(now / MIN_PER_DAY) + 1) * MIN_PER_DAY;
  for (const pc of s.pcList) {
    const mine = entries.filter((e) => e.pcs.includes(pc) && e.end > now).sort((a, b) => a.start - b.start);
    const current = mine.find((e) => e.start <= now);
    if (current) {
      // Зайнятий до кінця броні; якщо наступна починається впритул — до її кінця.
      let until = current.end;
      const who = [current.name || "без імені"];
      for (const e of mine) if (e !== current && e.start <= until && e.end > until) (until = e.end), who.push(e.name || "без імені");
      const label = `до ${formatHHMM(until)}${until > tomorrow ? " (наст. дня)" : ""} · ${who.join(", ")}`;
      const group = busy.get(label) ?? { label, pcs: [] };
      group.pcs.push(pc);
      busy.set(label, group);
    } else {
      const next = mine.find((e) => e.start > now && e.start < window.end);
      const key = next ? `до ${formatHHMM(next.start)} (далі ${next.name || "бронь"})` : `до закриття (${formatHHMM(window.end)})`;
      free.set(key, [...(free.get(key) ?? []), pc]);
    }
  }

  const lines = [`🟢 <b>Вільні зараз</b> · ${dayTitle(Math.floor(now / MIN_PER_DAY))} ${formatHHMM(now)}`];
  const freeCount = [...free.values()].reduce((n, l) => n + l.length, 0);
  if (!freeCount) lines.push("Вільних ПК немає.");
  for (const [key, pcs] of [...free.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`• ПК ${pcRuns(pcs, s.pcList)} — ${esc(key)}`);
  }
  if (busy.size) {
    lines.push("", "🔴 <b>Зайняті</b>");
    for (const { label, pcs } of busy.values()) lines.push(`• ПК ${pcRuns(pcs, s.pcList)} — ${esc(label)}`);
  }
  return lines.join("\n");
}

/** «🔎 Пошук» за ім'ям або телефоном: спершу майбутні, потім кілька останніх минулих. */
export function searchView(entries: Entry[], s: ViewSettings, query: string, now: number): string {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const found = entries.filter((e) => {
    const name = e.name.toLowerCase();
    const contact = e.contact.toLowerCase();
    if (q && (name.includes(q) || contact.includes(q))) return true;
    return digits.length >= 3 && e.contact.replace(/\D/g, "").includes(digits);
  });
  const head = `🔎 <b>Пошук «${esc(query.trim())}»</b>`;
  if (!found.length) return `${head}\n\nНічого не знайдено.`;
  const upcoming = found.filter((e) => e.end > now);
  const past = found.filter((e) => e.end <= now).reverse().slice(0, 5);
  const lines = [head];
  if (upcoming.length) lines.push("", "Майбутні:", ...clip(upcoming.map((e) => line(e, s.pcList, true))));
  if (past.length) lines.push("", "Минулі (останні):", ...past.map((e) => line(e, s.pcList, true)));
  return lines.join("\n");
}
