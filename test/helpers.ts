// Тестовий стенд: справжня SQLite (вбудована в Node) з тими самими міграціями, що й у D1.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Мінімальна реалізація інтерфейсу D1 поверх node:sqlite. */
export function fakeD1(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => sqlite.prepare(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

/** Розклад клубу, як зараз у «Налаштування»!A5:D11 (частки доби, як повертає API). */
export const CLUB_HOURS_ROWS: unknown[][] = [
  ["Понеділок", "Години", 0.5, 0],
  ["Вівторок", "Години", 0.5, 0],
  ["Середа", "Години", 0.5, 0],
  ["Четвер", "Години", 0.5, 0.25],
  ["П'ятниця", "Години", 0.5, 0.25],
  ["Субота", "Години", 0.5, 0.25],
  ["Неділя", "Години", 0.416666666666667, 0],
];

export const PC_LIST = Array.from({ length: 29 }, (_, i) => i + 1);

/** Рядок «Бронювання» A–U у вигляді, як його повертає API (UNFORMATTED_VALUE). */
export function sheetRow(v: {
  date: number;
  b: number;
  c?: number;
  from: string;
  to: string;
  name?: string;
  contact?: string;
  status?: string;
  id?: string;
}): unknown[] {
  const frac = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return (h! * 60 + m!) / 1440;
  };
  const row: unknown[] = [v.date, v.b, v.c ?? "", frac(v.from), frac(v.to), v.name ?? "Гість", v.contact ?? "", ""];
  while (row.length < 21) row.push("");
  row[10] = v.status ?? "";
  row[20] = v.id ?? "";
  return row;
}
