// Детермінований розбір повідомлення з бронюванням. Без мережі, без Telegram.
//
// Порядок важливий: кожен знайдений фрагмент «вирізається» (замінюється пробілами), щоб наступні
// правила його не бачили. Телефон → контакт → дата → ПК → тривалість → час → ім'я і примітка.

import { MIN_PER_DAY, dateToSerial, isValidDate, serialToDate, weekdayIndex } from "./time";

export interface Draft {
  date: number | null;
  pcs: number[];
  /** Хвилини від початку доби; `to` ≤ `from` — наступного дня. */
  from: number | null;
  to: number | null;
  name: string;
  contact: string;
  note: string;
  /** Зауваження розбору, які треба показати в картці. */
  hints: string[];
}

export interface ParseContext {
  /** Сьогоднішня серійна дата (часовий пояс клубу). */
  today: number;
  /** Список ПК із «Налаштування»; без нього діапазони розгортаються числами. */
  pcList?: number[];
}

export interface ParseResult {
  draft: Draft;
  /** Чи схоже повідомлення на бронь (інакше бот мовчить). */
  signals: boolean;
  /** Чого не вистачає з обов'язкового. */
  missing: string[];
}

export const emptyDraft = (): Draft => ({ date: null, pcs: [], from: null, to: null, name: "", contact: "", note: "", hints: [] });

/* ───────────── службове ───────────── */

/** Межі слова для кирилиці (\b у JS працює лише з латиницею). */
const B = String.raw`(?<![\p{L}\d'])`;
const E = String.raw`(?![\p{L}\d'])`;
/** Число, перед яким не стоїть літера, цифра, «:» або «.» (щоб не відкусити хвилини «22:00»). */
const NB = String.raw`(?<![\p{L}\d:.'])`;
/** Після числа — не цифра і не «:05» / «.30». */
const NE = String.raw`(?!\d|[:.]\d)`;

const re = (src: string) => new RegExp(src, "giu");

class Work {
  text: string;
  low: string;
  constructor(input: string) {
    // Однакова довжина рядків: замінюємо по одному символу.
    this.text = input.replace(/[–—−]/g, "-").replace(/[’ʼ`]/g, "'").replace(/ /g, " ");
    this.low = this.text.toLowerCase();
  }
  cut(start: number, end: number) {
    const pad = " ".repeat(end - start);
    this.text = this.text.slice(0, start) + pad + this.text.slice(end);
    this.low = this.low.slice(0, start) + pad + this.low.slice(end);
  }
  /** Пройти всі збіги; якщо `fn` повертає true — вирізати збіг. */
  each(regex: RegExp, fn: (m: RegExpMatchArray) => boolean | void) {
    for (const m of [...this.low.matchAll(regex)]) {
      if (fn(m) === true) this.cut(m.index!, m.index! + m[0].length);
    }
  }
}

/* ───────────── контакт ───────────── */

const CONTACT_WORDS: [RegExp, string][] = [
  [re(`${B}(?:tg|тг|telegram|телеграм\\p{L}*|телега|телезі)${E}`), "tg"],
  [re(`${B}(?:insta|instagram|інста\\p{L}*|инста\\p{L}*|інстаграм\\p{L}*|инстаграм\\p{L}*)${E}`), "insta"],
  [re(`${B}(?:whatsapp|ватсап\\p{L}*|вацап\\p{L}*)${E}`), "whatsapp"],
  [re(`${B}(?:viber|вайбер\\p{L}*)${E}`), "viber"],
  [re(`${B}(?:дзвінок|дзвонив|дзвонила|дзвонили|звонок|звонил\\p{L}*|по\\s+телефону|call)${E}`), "дзвінок"],
];

const PHONE = re(String.raw`(?<![\d+])(\+\d[\d \-()]{7,18}\d|\d{3}[\d \-()]{5,15}\d)(?!\d)`);

/** Текст-контакт → нормалізований («телеграм» → «tg»); інакше як є. */
export function normalizeContact(text: string): string {
  const t = text.trim();
  for (const [rx, value] of CONTACT_WORDS) {
    rx.lastIndex = 0;
    if (rx.test(t.toLowerCase()) && t.split(/\s+/).length <= 2) return value;
  }
  return t;
}

function takeContacts(w: Work): string[] {
  const found: string[] = [];
  w.each(PHONE, (m) => {
    const digits = m[0].replace(/\D/g, "").length;
    if (digits < 9 || digits > 15) return false;
    found.push(w.text.slice(m.index!, m.index! + m[0].length).trim());
    return true;
  });
  w.each(re(String.raw`(?<![\w@])@[a-z0-9_]{4,32}(?![\w])`), (m) => {
    found.push(w.text.slice(m.index!, m.index! + m[0].length));
    return true;
  });
  for (const [rx, value] of CONTACT_WORDS) {
    w.each(rx, () => {
      if (!found.includes(value)) found.push(value);
      return true;
    });
  }
  return found;
}

/* ───────────── дата ───────────── */

const WEEKDAYS: [string, number][] = [
  ["понеділок|понеділка|понедельник|пон|пн", 0],
  ["вівторок|вівторка|вторник|вів|вт", 1],
  ["середа|середу|среда|среду|сер|ср", 2],
  ["четвер|четверг|чет|чт", 3],
  ["п'ятниця|п'ятницю|пятниця|пятницю|пятница|пятницу|п'ят|пят|пт", 4],
  ["субота|суботу|суббота|субботу|суб|сб", 5],
  ["неділя|неділю|воскресенье|воскр|нед|нд|вс", 6],
];
const WEEKDAY_RX = WEEKDAYS.map(([alts]) => alts).join("|");
const weekdayOf = (word: string) => WEEKDAYS.find(([alts]) => alts.split("|").includes(word))![1];

const MONTHS = [
  "січня|января",
  "лютого|февраля",
  "березня|марта",
  "квітня|апреля",
  "травня|мая",
  "червня|июня",
  "липня|июля",
  "серпня|августа",
  "вересня|сентября",
  "жовтня|октября",
  "листопада|ноября",
  "грудня|декабря",
];
const MONTH_RX = MONTHS.join("|");

export const WEEKDAY_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "нд"];

/** Дата без року: цей рік, а якщо минула більше ніж тиждень тому — наступний. */
function inferYear(m: number, d: number, today: number): number | null {
  const { y } = serialToDate(today);
  for (const year of [y, y + 1]) {
    if (!isValidDate(year, m, d)) continue;
    if (dateToSerial(year, m, d) >= today - 7) return dateToSerial(year, m, d);
  }
  return null;
}

/** Найближча дата (від сьогодні) з таким числом місяця. */
function nearestDayOfMonth(day: number, today: number): number | null {
  let { y, m } = serialToDate(today);
  for (let i = 0; i < 13; i++) {
    if (isValidDate(y, m, day) && dateToSerial(y, m, day) >= today) return dateToSerial(y, m, day);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return null;
}

function takeDate(w: Work, ctx: ParseContext, hints: string[], pcKeywordCount: number): number | null {
  let date: number | null = null;
  const set = (value: number | null) => {
    if (value === null) return false;
    if (date === null) date = value;
    return true;
  };

  w.each(re(`${B}(?:післязавтра|послезавтра)${E}`), () => set(ctx.today + 2));
  w.each(re(`${B}(?:завтра|tomorrow)${E}`), () => set(ctx.today + 1));
  w.each(re(`${B}(?:сьогодні|сьодні|сегодня|today)${E}`), () => set(ctx.today));

  // 21.11 / 21.11.2026 / 21/11 / 21.11.26
  w.each(re(String.raw`${NB}(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?(?![\d]|[:.]\d)`), (m) => {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1) return false; // «19.00» — це час
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return isValidDate(y, mo, d) ? set(dateToSerial(y, mo, d)) : false;
    }
    return set(inferYear(mo, d, ctx.today));
  });

  // 21 листопада
  w.each(re(`${NB}(\\d{1,2})\\s+(${MONTH_RX})${E}`), (m) => {
    const mo = MONTHS.findIndex((alts) => alts.split("|").includes(m[2]!)) + 1;
    return set(inferYear(mo, Number(m[1]), ctx.today));
  });

  // День тижня, можливо з числом: «пт», «у п'ятницю», «пт 18»
  w.each(re(`${B}(${WEEKDAY_RX})${E}(?:\\.?\\s*,?\\s*(\\d{1,2})(?![\\d:.]|\\s*-\\s*\\d|\\s*(?:год|h|ч)))?`), (m) => {
    const wd = weekdayOf(m[1]!);
    const num = m[2] ? Number(m[2]) : null;
    // «пт 18 пк 12-17»: за «пк» іде номер — отже 18 — число місяця.
    // «пт 18 пк з 22 до 4»: за «пк» номера немає — 18 і є ПК.
    const after = w.low.slice(m.index! + m[0].length);
    const numIsPc =
      num !== null && new RegExp(`^\\s*${PC_KW}`, "u").test(after) && !new RegExp(`^\\s*${PC_KW}\\s*(?:№|#|:)?\\s*\\d`, "u").test(after);
    if (num !== null && !numIsPc && num >= 1 && num <= 31) {
      const value = nearestDayOfMonth(num, ctx.today);
      if (value !== null && weekdayIndex(value) !== wd) {
        hints.push(`${formatShort(value)} — це ${WEEKDAY_SHORT[weekdayIndex(value)]}, а не ${WEEKDAY_SHORT[wd]}: перевірте дату`);
      }
      return set(value);
    }
    if (numIsPc) {
      // Вирізаємо лише день тижня, число лишаємо для ПК.
      w.cut(m.index!, m.index! + m[1]!.length);
      set(ctx.today + ((wd - weekdayIndex(ctx.today) + 7) % 7));
      return false;
    }
    return set(ctx.today + ((wd - weekdayIndex(ctx.today) + 7) % 7));
  });

  return date;
}

const formatShort = (serial: number) => {
  const { y, m, d } = serialToDate(serial);
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;
};

/* ───────────── ПК ───────────── */

const PC_KW = String.raw`(?:пк|pc|компи|компы|комп|комп'ютери|комп'ютера|комп'ютер|компьютеры|компьютера|компьютер)`;
const NUM = String.raw`${NB}\d{1,2}${NE}`;
const ITEM = String.raw`${NUM}(?:\s*-\s*\d{1,2}${NE})?`;
const LIST = String.raw`${ITEM}(?:\s*(?:,|;|\+|&|і|и|та)\s*\d{1,2}${NE}(?:\s*-\s*\d{1,2}${NE})?)*`;

/** «12-17, 20» → [12..17, 20] за списком ПК. */
function expandList(list: string, pcList: number[] | undefined, unknown: number[]): number[] {
  const out: number[] = [];
  for (const part of list.split(/\s*(?:,|;|\+|&|і|и|та)\s*/u)) {
    const m = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (pcList) {
      const inRange = pcList.filter((pc) => pc >= lo && pc <= hi);
      out.push(...inRange);
      for (const n of lo === hi ? [lo] : [lo, hi]) if (!pcList.includes(n)) unknown.push(n);
    } else {
      for (let n = lo; n <= hi; n++) out.push(n);
    }
  }
  return out;
}

function takePcs(w: Work, ctx: ParseContext, hints: string[]): number[] {
  const pcs: number[] = [];
  const unknown: number[] = [];
  const add = (list: string) => pcs.push(...expandList(list, ctx.pcList, unknown));

  // «18 пк», «12-14 пк», «12, 14 пк»
  w.each(re(String.raw`(${LIST})\s*${PC_KW}${E}`), (m) => {
    add(m[1]!);
    return true;
  });
  // «пк з 12 по 17» («з 19 до 21» — це час, тому «до» тут не приймаємо)
  w.each(re(String.raw`${B}${PC_KW}${E}\s*(?:з|с|від|от)\s*(\d{1,2})\s*(?:по|-)\s*(\d{1,2})${NE}`), (m) => {
    add(`${m[1]}-${m[2]}`);
    return true;
  });
  // «пк 18», «ПК 12–17», «пк 12,14,16», «пк№5»
  w.each(re(String.raw`${B}${PC_KW}\s*(?:№|#|:)?\s*(${LIST})`), (m) => {
    add(m[1]!);
    return true;
  });

  if (unknown.length) hints.push(`ПК ${[...new Set(unknown)].join(", ")} немає у списку «Налаштування»`);
  return [...new Set(pcs)].sort((a, b) => a - b);
}

/** Окреме поле «ПК» (при зміні): «пк» не обов'язкове. */
export function parsePcsInput(text: string, pcList?: number[]): { pcs: number[]; hints: string[] } {
  const hints: string[] = [];
  const w = new Work(text);
  let pcs = takePcs(w, { today: 0, pcList }, hints);
  if (!pcs.length) {
    const m = new RegExp(`^\\s*(${LIST})\\s*$`, "u").exec(w.low);
    const unknown: number[] = [];
    if (m) pcs = [...new Set(expandList(m[1]!, pcList, unknown))].sort((a, b) => a - b);
    if (unknown.length) hints.push(`ПК ${[...new Set(unknown)].join(", ")} немає у списку «Налаштування»`);
  }
  return { pcs, hints };
}

/* ───────────── час ───────────── */

function toMinutes(h: string, m: string | undefined): number | null {
  const hh = Number(h);
  const mm = m === undefined ? 0 : Number(m);
  if (hh > 24 || mm > 59 || (hh === 24 && mm > 0)) return null;
  return hh * 60 + mm;
}

interface Times {
  from: number | null;
  to: number | null;
  duration: number | null;
  /** Знайдено діапазон або початок + тривалість (а не просто «о 19:00»). */
  strong: boolean;
}

function takeDuration(w: Work): number | null {
  let duration: number | null = null;
  w.each(
    re(String.raw`${B}(?:на\s+)?(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:години|годину|годин|год|часа|часов|час|ч|h)(?![\p{L}\d])\.?`),
    (m) => {
      const hours = Number(m[1]!.replace(",", "."));
      if (!(hours > 0 && hours <= 24) || duration !== null) return false;
      duration = Math.round(hours * 60);
      return true;
    },
  );
  const words: [string, number][] = [
    ["півтори\\s+години|полтора\\s+часа", 90],
    ["пів\\s*години|півгодини|полчаса", 30],
    ["годину|час", 60],
  ];
  for (const [rx, minutes] of words) {
    w.each(re(`${B}на\\s+(?:${rx})${E}`), () => {
      if (duration !== null) return false;
      duration = minutes;
      return true;
    });
  }
  return duration;
}

const T = String.raw`(\d{1,2})(?:[:.](\d{2}))?`;

function takeTimes(w: Work): Times {
  const t: Times = { from: null, to: null, duration: takeDuration(w), strong: false };

  // «19:00-02:00», «з 19 до 2», «19-2», «від 18 по 22»
  w.each(re(String.raw`${NB}(?:(?:з|с|від|от)\s*)?${T}\s*(?:-|до|по)\s*${T}${NE}`), (m) => {
    if (t.from !== null) return false;
    const from = toMinutes(m[1]!, m[2]);
    const to = toMinutes(m[3]!, m[4]);
    if (from === null || to === null || from === MIN_PER_DAY) return false;
    t.from = from;
    t.to = to;
    t.strong = true;
    return true;
  });
  // «з 20:00», «о 19»
  w.each(re(String.raw`${B}(?:з|с|від|от|о|об)\s+${T}${NE}`), (m) => {
    if (t.from !== null) return false;
    t.from = toMinutes(m[1]!, m[2]);
    return t.from !== null;
  });
  // «до 22»
  w.each(re(String.raw`${B}(?:до|по)\s+${T}${NE}`), (m) => {
    if (t.to !== null) return false;
    t.to = toMinutes(m[1]!, m[2]);
    return t.to !== null;
  });
  // голе «20:00»
  w.each(re(String.raw`${NB}(\d{1,2}):(\d{2})${NE}`), (m) => {
    const v = toMinutes(m[1]!, m[2]);
    if (v === null) return false;
    if (t.from === null) t.from = v;
    else if (t.to === null) t.to = v;
    else return false;
    return true;
  });

  if (t.duration !== null) {
    if (t.from !== null && t.to === null) t.to = (t.from + t.duration) % MIN_PER_DAY;
    else if (t.to !== null && t.from === null) t.from = (t.to - t.duration + MIN_PER_DAY) % MIN_PER_DAY;
    if (t.from !== null && t.to !== null) t.strong = true;
  }
  return t;
}

/** Окреме поле «Час» (при зміні): «19-2», «19:00-02:00», «з 20 на 3 години». */
export function parseTimeInput(text: string): { from: number; to: number } | null {
  const t = takeTimes(new Work(text));
  return t.from !== null && t.to !== null ? { from: t.from, to: t.to } : null;
}

/** Окреме поле «Дата» (при зміні). */
export function parseDateInput(text: string, ctx: ParseContext): { date: number | null; hints: string[] } {
  const hints: string[] = [];
  const w = new Work(text);
  let date = takeDate(w, ctx, hints, 0);
  if (date === null) {
    const m = /^\s*(\d{1,2})\s*$/.exec(w.low);
    if (m) date = nearestDayOfMonth(Number(m[1]), ctx.today);
  }
  return { date, hints };
}

/* ───────────── ім'я і примітка ───────────── */

const NOISE = new Set(
  (
    "з с до по на від от о об в у і и та для бронь броня брон бронюю бронювання бронирование бронь: забронювати забронюйте " +
    "забронируй забронировать запиши запишіть записати резерв прошу будь ласка пожалуйста треба потрібно нужно " +
    "год години годин часа часов клієнт клиент гість ім'я імя имя тел телефон номер контакт примітка коментар"
  ).split(" "),
);
const WORD = /^\p{L}[\p{L}'-]*$/u;
const capitalized = (s: string) => s[0] !== s[0]!.toLowerCase();

function takeNameAndNote(w: Work): { name: string; note: string } {
  const segments = w.text
    .split(/[,;\n]|\s-\s/)
    .map((seg) =>
      seg
        .split(/\s+/)
        .map((tok) => tok.replace(/^[^\p{L}\d+@#]+|[^\p{L}\d)!?]+$/gu, ""))
        .filter(Boolean),
    )
    .map((toks) => {
      // Службові слова відкидаємо лише по краях фрагмента («день народження для сина» лишається цілим).
      while (toks.length && NOISE.has(toks[0]!.toLowerCase())) toks.shift();
      while (toks.length && NOISE.has(toks[toks.length - 1]!.toLowerCase())) toks.pop();
      return toks;
    })
    .filter((toks) => toks.length);

  // Ім'я: перше слово з великої літери; якщо такого немає — перше слово взагалі.
  let pos: [number, number] | null = null;
  for (const pass of [true, false]) {
    for (let s = 0; s < segments.length && !pos; s++) {
      const i = segments[s]!.findIndex((tok) => WORD.test(tok) && !NOISE.has(tok.toLowerCase()) && (!pass || capitalized(tok)));
      if (i >= 0) pos = [s, i];
    }
    if (pos) break;
  }

  let name = "";
  if (pos) {
    const seg = segments[pos[0]]!;
    const [first] = seg.splice(pos[1], 1);
    name = first!;
    // Прізвище: наступне слово з великої літери в тому ж фрагменті.
    const next = seg[pos[1]];
    if (next && capitalized(name) && WORD.test(next) && capitalized(next)) {
      seg.splice(pos[1], 1);
      name += " " + next;
    }
  }
  const note = segments
    .map((toks) => toks.join(" "))
    .filter(Boolean)
    .join(", ");
  return { name, note };
}

/* ───────────── усе разом ───────────── */

const BOOKING_WORD = re(`${B}(?:бронь|броня|бронюю|бронювання|бронирование|забронювати|забронюйте|забронируй|забронировать|резерв)${E}`);

export function missingFields(d: Draft): string[] {
  const missing: string[] = [];
  if (d.date === null) missing.push("дата");
  if (!d.pcs.length) missing.push("ПК");
  if (d.from === null) missing.push("час початку");
  if (d.to === null) missing.push("час кінця");
  if (!d.name) missing.push("ім'я");
  return missing;
}

export function parseBooking(input: string, ctx: ParseContext): ParseResult {
  const w = new Work(input);
  const draft = emptyDraft();
  const bookingWord = re(BOOKING_WORD.source).test(w.low);
  const pcKeywordCount = [...w.low.matchAll(re(`${B}${PC_KW}${E}`))].length;

  const contacts = takeContacts(w);
  draft.contact = contacts.join(", ");
  draft.date = takeDate(w, ctx, draft.hints, pcKeywordCount);
  draft.pcs = takePcs(w, ctx, draft.hints);
  const times = takeTimes(w);
  draft.from = times.from;
  draft.to = times.to;
  const { name, note } = takeNameAndNote(w);
  draft.name = name;
  draft.note = note;

  // Ознаки броні: «пк» + час або дата; діапазон часу + контакт/«бронь»; «бронь» + щось із даних.
  // «пк 12 не працює», «буду о 19:00», «завтра прибирання з 10 до 12» — переписка, бот мовчить.
  const hasTime = times.from !== null || times.to !== null;
  const signals =
    (pcKeywordCount > 0 && (hasTime || draft.date !== null)) ||
    (times.strong && (contacts.length > 0 || bookingWord)) ||
    (bookingWord && (hasTime || draft.date !== null || draft.pcs.length > 0));

  return { draft, signals, missing: missingFields(draft) };
}
