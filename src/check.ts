// Перевірка чернетки перед записом: чого бракує, накладки, робочі години, минуле.

import { bookingInterval, findConflicts, isOkStatus, type Conflict, type NewBooking, type SheetBooking } from "./bookings";
import { isWithinHours, type DaySchedule } from "./hours";
import { missingFields, type Draft } from "./parse";

export interface Check {
  missing: string[];
  conflicts: Conflict[];
  outOfHours: boolean;
  past: boolean;
}

export function evaluate(
  draft: Draft,
  bookings: SheetBooking[],
  schedule: DaySchedule[],
  nowAbs: number,
  ignoreBotId?: string,
): Check {
  const missing = missingFields(draft);
  const check: Check = { missing, conflicts: [], outOfHours: false, past: false };
  if (draft.date === null || draft.from === null || draft.to === null) return check;
  const { start, end } = bookingInterval(draft.date, draft.from, draft.to);
  check.outOfHours = !isWithinHours(schedule, draft.date, start, end);
  check.past = start < nowAbs;
  if (draft.pcs.length) check.conflicts = findConflicts({ pcs: draft.pcs, start, end }, bookings, ignoreBotId);
  return check;
}

export const isComplete = (c: Check) => c.missing.length === 0;
export const hasWarnings = (c: Check) => c.conflicts.length > 0 || c.outOfHours || c.past;

/** Що каже бот одним словом — для порівняння з колонкою K. */
export const botVerdictOk = (c: Check) => c.conflicts.length === 0 && !c.outOfHours;

/** Розходиться бот із таблицею? (минуле таблиця не позначає, тож його не порівнюємо) */
export const verdictMismatch = (c: Check, statuses: string[]) => botVerdictOk(c) !== statuses.every(isOkStatus);

export function toNewBooking(d: Draft): NewBooking {
  if (d.date === null || d.from === null || d.to === null) throw new Error("Чернетка неповна");
  return { date: d.date, pcs: d.pcs, from: d.from, to: d.to, name: d.name, contact: d.contact, note: d.note };
}
