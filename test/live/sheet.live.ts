// Жива перевірка модуля таблиці на справжній Google Таблиці.
//   npm run test:live
// Ключ і SHEET_ID: GOOGLE_SA_KEY з .dev.vars, SHEET_ID з .dev.vars або wrangler.toml. Ключ не друкується.
//
// Що робить:
//  1. Перевіряє/вписує заголовок U9 «ID бота».
//  2. Звіряє розбір годин роботи з формулами таблиці (Sched_S / Sched_E).
//  3. Записує 3 тестові броні на наступний тиждень: звичайна, нічна до 02:00, група з накладкою на першу.
//  4. Звіряє K кожного рядка «Бронювання» з тим, що рахує бот (expectedStatus).
//  5. Тимчасово ставить у B3 (перемикач тижня) дату наступного тижня, звіряє K і розклади «Вт» / «Пт»
//     клітинка в клітинку, потім повертає B3 формулу =TODAY().
//  6. Видаляє тестові рядки (A–H і U) і перевіряє, що їх не лишилося.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { complete, expectedStatus, findConflicts, newBookingId, pcsInRange, type NewBooking, type SheetBooking } from "../../src/bookings";
import { isWithinHours } from "../../src/hours";
import {
  BOOKINGS,
  SETTINGS,
  batchGet,
  clearBooking,
  ensureIdHeader,
  findRowsById,
  loadSettings,
  readSnapshot,
  sheetRange,
  writeBooking,
  writeCells,
  type SheetCtx,
  type Snapshot,
} from "../../src/sheet";
import { MIN_PER_DAY, formatDate, formatHHMM, mondayOf, zonedNow } from "../../src/time";
import { fakeD1 } from "../helpers";

function devVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0 || line.startsWith("#")) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    vars[line.slice(0, eq).trim()] = v;
  }
  return vars;
}

const vars = devVars();
const sheetId = vars.SHEET_ID || /SHEET_ID\s*=\s*"([^"]+)"/.exec(readFileSync("wrangler.toml", "utf8"))![1]!;
const ctx: SheetCtx = { db: fakeD1(), sheetId, saKey: vars.GOOGLE_SA_KEY ?? "" };

const today = zonedNow("Europe/Warsaw").serial;
const nextMon = mondayOf(today) + 7;
const TUE = nextMon + 1;
const FRI = nextMon + 4;
const H = 60;
const NOTE = "ТЕСТ бота — буде видалено автоматично";

const tests: { key: string; label: string; booking: NewBooking; id: string }[] = [
  {
    key: "T1",
    label: "звичайна: вт ПК 5, 18:00–20:00",
    booking: { date: TUE, pcs: [5], from: 18 * H, to: 20 * H, name: "ТЕСТ бот 1", contact: "+48 000 000 001", note: NOTE },
    id: newBookingId(),
  },
  {
    key: "T2",
    label: "нічна: пт ПК 7, 22:00–02:00",
    booking: { date: FRI, pcs: [7], from: 22 * H, to: 2 * H, name: "ТЕСТ бот 2", contact: "tg", note: NOTE },
    id: newBookingId(),
  },
  {
    key: "T3",
    label: "група з накладкою: вт ПК 3–6, 19:00–21:00",
    booking: { date: TUE, pcs: [3, 4, 5, 6], from: 19 * H, to: 21 * H, name: "ТЕСТ бот 3", contact: "insta", note: NOTE },
    id: newBookingId(),
  },
];

const log: string[] = [];
const say = (s: string) => log.push(s);
let b3Changed = false;

/** Звірити K усіх рядків з перевіркою бота. Повертає розбіжності. */
function compareStatuses(snap: Snapshot): string[] {
  const diffs: string[] = [];
  for (const b of snap.bookings) {
    const exp = expectedStatus(b, snap.bookings, snap.settings.schedule, snap.settings.pcList, snap.weekMon);
    if (exp !== b.status) diffs.push(`рядок ${b.row} (${b.name}): таблиця «${b.status}», бот «${exp}»`);
  }
  return diffs;
}

/** Підпис у розкладі (колонка Q, R_Name): ім'я + « ×N» для групи. */
const scheduleName = (b: SheetBooking, pcList: number[]) => {
  const c = complete(b)!;
  return b.name + (c.hi > c.lo ? ` ×${pcsInRange(pcList, c.lo, c.hi).length}` : "");
};

/** Розклад дня «клітинка в клітинку»: LOOKUP(2; 1/(…); R_Name) = останній за номером рядка збіг. */
async function compareDaySheet(sheet: string, snap: Snapshot) {
  const [grid] = await batchGet(ctx, [sheetRange(sheet, "A1:AD60")]);
  const day = grid![0]![4] as number;
  const pcs = (grid![3] ?? []).slice(1) as number[];
  const diffs: string[] = [];
  const hits: string[] = [];
  for (let r = 4; r < grid!.length; r++) {
    const a = grid![r]![0];
    if (typeof a !== "number") continue;
    const slot = Math.round((day + a) * MIN_PER_DAY);
    pcs.forEach((pc, j) => {
      let expected = "";
      for (const b of snap.bookings) {
        const c = complete(b);
        if (c && c.lo <= pc && c.hi >= pc && c.start < slot + 60 && c.end > slot) expected = scheduleName(b, snap.settings.pcList);
      }
      const actual = String(grid![r]![j + 1] ?? "");
      if (actual !== expected) diffs.push(`${sheet} ${formatHHMM(slot)} ПК ${pc}: таблиця «${actual}», бот «${expected}»`);
      if (actual.startsWith("ТЕСТ")) hits.push(`${formatHHMM(slot)} ПК ${pc} = ${actual}`);
    });
  }
  return { day, diffs, hits };
}

describe.sequential("жива таблиця", () => {
  afterAll(async () => {
    // Прибирання — навіть якщо перевірки впали.
    if (b3Changed) {
      await writeCells(ctx, [{ range: sheetRange(BOOKINGS, "B3"), values: [["=TODAY()"]] }], "USER_ENTERED");
      const [b3] = await batchGet(ctx, [sheetRange(BOOKINGS, "B3")]);
      say(`B3 повернуто на =TODAY() → ${formatDate(b3![0]![0] as number)}`);
    }
    for (const t of tests) {
      const rows = await clearBooking(ctx, t.id);
      if (rows.length) say(`${t.key}: видалено рядки ${rows.join(", ")}`);
    }
    const left = (await Promise.all(tests.map((t) => findRowsById(ctx, t.id)))).flat();
    say(left.length ? `❌ ЛИШИЛИСЬ тестові рядки: ${left.join(", ")}` : "✅ тестових рядків у таблиці не лишилось");
    console.log("\n" + log.join("\n") + "\n");
    expect(left).toEqual([]);
  });

  it("1. заголовок U9", async () => {
    const wrote = await ensureIdHeader(ctx);
    const [u9] = await batchGet(ctx, [sheetRange(BOOKINGS, "U9")]);
    say(`U9: «${u9![0]![0]}»${wrote ? " (вписано зараз)" : " (уже був)"}`);
    expect(u9![0]![0]).toBe("ID бота");
  });

  it("2. години роботи: розбір бота = Sched_S/Sched_E таблиці", async () => {
    const settings = await loadSettings(ctx, { fresh: true });
    const [sched, c15] = await batchGet(ctx, [sheetRange(SETTINGS, "X5:Y11"), sheetRange(SETTINGS, "C15")]);
    const fromSheet = sched!.map((r) => ({ start: Math.round((r[0] as number) * MIN_PER_DAY), end: Math.round((r[1] as number) * MIN_PER_DAY) }));
    const fromBot = settings.schedule.map((d) => ({ start: d.start, end: d.end }));
    say(`Години (бот): ${settings.schedule.map((d, i) => `${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"][i]} ${formatHHMM(d.start)}–${formatHHMM(d.end)}${d.end > MIN_PER_DAY ? "(+1)" : ""}`).join(", ")}`);
    say(`ПК: ${settings.pcList.length} (${settings.pcList[0]}–${settings.pcList.at(-1)}), Stream: ${settings.pcList.filter((p) => settings.zones[p] === "Stream").join(", ")}; C15 сирий = ${JSON.stringify(c15![0]![0])} → ${formatHHMM(settings.firstHour)}`);
    expect(fromBot).toEqual(fromSheet);
  });

  it("3. перевірка бота перед записом і запис трьох броней", async () => {
    let snap = await readSnapshot(ctx);
    say(`Наступний тиждень: ${formatDate(nextMon)}–${formatDate(nextMon + 6)}. Броней у таблиці до тесту: ${snap.bookings.length}`);

    // Справжні броні, що зачіпають тестові ПК/час, зіпсували б перевірку — тоді зупиняємось нічого не записавши.
    for (const t of tests) {
      const c = complete({ row: 0, date: t.booking.date, pcB: t.booking.pcs[0]!, pcC: null, from: t.booking.from, to: t.booking.to, name: "", contact: "", note: "", status: "", botId: "" })!;
      const real = findConflicts({ pcs: t.booking.pcs, start: c.start, end: c.end }, snap.bookings);
      expect(real, `${t.key}: на цей час уже є справжні броні`).toEqual([]);
    }

    for (const t of tests) {
      const c = complete({ row: 0, date: t.booking.date, pcB: t.booking.pcs[0]!, pcC: null, from: t.booking.from, to: t.booking.to, name: "", contact: "", note: "", status: "", botId: "" })!;
      const conflicts = findConflicts({ pcs: t.booking.pcs, start: c.start, end: c.end }, snap.bookings);
      const inHours = isWithinHours(snap.settings.schedule, t.booking.date, c.start, c.end);
      const check = conflicts.length
        ? `⚠ накладка: ${conflicts.map((x) => `ПК ${x.pcs.join(", ")} — ${x.booking.name} ${formatHHMM(x.booking.from)}–${formatHHMM(x.booking.to)}`).join("; ")}`
        : inHours ? "✅ вільно" : "⏰ поза годинами";
      const res = await writeBooking(ctx, t.booking, t.id, snap.settings.pcList);
      say(`${t.key} ${t.label} (${formatDate(t.booking.date)}): перевірка бота «${check}» → рядок ${res.rows.join(",")}, K одразу після запису «${res.statuses.join(" | ")}»`);
      if (t.key === "T3") expect(conflicts.map((x) => x.booking.name)).toEqual(["ТЕСТ бот 1"]);
      else expect(conflicts).toEqual([]);
      expect(inHours).toBe(true);
      snap = await readSnapshot(ctx);
    }
  });

  it("4. K усіх рядків = перевірка бота (вибрано поточний тиждень)", async () => {
    const snap = await readSnapshot(ctx);
    for (const t of tests) {
      const b = snap.bookings.find((x) => x.botId === t.id)!;
      say(`  ${t.key}: K = «${b.status}»`);
    }
    const diffs = compareStatuses(snap);
    say(`Звірка K (тиждень ${formatDate(snap.weekMon)}): ${snap.bookings.length} рядків, розбіжностей ${diffs.length}`);
    diffs.forEach((d) => say("  ❗ " + d));
    expect(diffs).toEqual([]);
    expect(snap.bookings.find((x) => x.botId === tests[0]!.id)!.status).toBe("⚠ НАКЛАДКА: ПК вже зайнятий");
    expect(snap.bookings.find((x) => x.botId === tests[1]!.id)!.status).toBe("✓ інший тиждень");
    expect(snap.bookings.find((x) => x.botId === tests[2]!.id)!.status).toBe("⚠ НАКЛАДКА: ПК з групи зайнятий");
  });

  it("5. наступний тиждень у B3: K і розклади «Вт» / «Пт» клітинка в клітинку", async () => {
    b3Changed = true;
    await writeCells(ctx, [{ range: sheetRange(BOOKINGS, "B3"), values: [[TUE]] }], "RAW");
    const snap = await readSnapshot(ctx);
    expect(snap.weekMon).toBe(nextMon);
    for (const t of tests) say(`  ${t.key}: K = «${snap.bookings.find((x) => x.botId === t.id)!.status}»`);
    const diffs = compareStatuses(snap);
    say(`Звірка K (тиждень ${formatDate(snap.weekMon)}): розбіжностей ${diffs.length}`);
    diffs.forEach((d) => say("  ❗ " + d));
    expect(snap.bookings.find((x) => x.botId === tests[1]!.id)!.status).toBe("✓ OK");

    for (const sheet of ["Вт", "Пт"]) {
      const { day, diffs: d, hits } = await compareDaySheet(sheet, snap);
      say(`Розклад «${sheet}» ${formatDate(day)}: розбіжностей ${d.length}; тестові клітинки: ${hits.join("; ") || "—"}`);
      d.slice(0, 15).forEach((x) => say("  ❗ " + x));
      diffs.push(...d);
    }
    expect(diffs).toEqual([]);
  });
});
