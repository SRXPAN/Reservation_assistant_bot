// Фейковий Google (токен + Sheets values API) у пам'яті — для тестів sheet.ts і google.ts.

type Cell = string | number;

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** «'Аркуш'!A10:U1009» або «'Аркуш'!U9» → аркуш і прямокутник (0-based, включно). */
export function parseA1(a1: string) {
  const m = /^'(.+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1);
  if (!m) throw new Error(`Незрозумілий діапазон: ${a1}`);
  const [, sheet, c1, r1, c2, r2] = m;
  return {
    sheet: sheet!,
    r1: Number(r1),
    c1: colIndex(c1!),
    r2: Number(r2 ?? r1),
    c2: colIndex(c2 ?? c1!),
  };
}

export class FakeGoogle {
  /** sheet → "row:col" → значення. */
  grid = new Map<string, Map<string, Cell>>();
  calls: { method: string; url: string; body?: any }[] = [];
  tokenRequests = 0;
  /** Імітувати недоступність Google на читання. */
  failReads = false;
  /** Перехопити запис (наприклад, щоб імітувати чужий запис у той самий рядок). */
  onUpdate?: (data: { range: string; values: unknown[][] }[]) => void;
  /** Статус, який «порахує» таблиця в K для записаного рядка. */
  statusFor: (row: number) => string = () => "✓ OK";

  set(sheet: string, row: number, col: number, value: Cell) {
    if (!this.grid.has(sheet)) this.grid.set(sheet, new Map());
    const s = this.grid.get(sheet)!;
    if (value === "") s.delete(`${row}:${col}`);
    else s.set(`${row}:${col}`, value);
  }

  get(sheet: string, row: number, col: number): Cell | undefined {
    return this.grid.get(sheet)?.get(`${row}:${col}`);
  }

  setRow(sheet: string, row: number, values: unknown[]) {
    values.forEach((v, c) => this.set(sheet, row, c, (v ?? "") as Cell));
  }

  /** Значення, як віддає API: обрізані порожні хвости рядків і колонок. */
  read(a1: string): unknown[][] {
    const r = parseA1(a1);
    const rows: unknown[][] = [];
    for (let row = r.r1; row <= r.r2; row++) {
      const vals: unknown[] = [];
      for (let col = r.c1; col <= r.c2; col++) vals.push(this.get(r.sheet, row, col) ?? "");
      while (vals.length && vals[vals.length - 1] === "") vals.pop();
      rows.push(vals);
    }
    while (rows.length && rows[rows.length - 1]!.length === 0) rows.pop();
    return rows;
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init?.body;
    this.calls.push({ method, url, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      this.tokenRequests++;
      return json({ access_token: `token-${this.tokenRequests}`, expires_in: 3600 });
    }
    const u = new URL(url);
    if (this.failReads && u.pathname.endsWith("/values:batchGet")) {
      return json({ error: { message: "The service is currently unavailable." } }, 503);
    }
    if (u.pathname.endsWith("/values:batchGet")) {
      return json({ valueRanges: u.searchParams.getAll("ranges").map((r) => ({ range: r, values: this.read(r) })) });
    }
    if (u.pathname.endsWith("/values:batchUpdate")) {
      this.onUpdate?.(body.data);
      for (const d of body.data as { range: string; values: Cell[][] }[]) {
        const r = parseA1(d.range);
        d.values.forEach((vals, i) => vals.forEach((v, j) => this.set(r.sheet, r.r1 + i, r.c1 + j, v)));
        if (r.c1 === 0) for (let row = r.r1; row <= r.r2; row++) this.set(r.sheet, row, 10, this.statusFor(row));
      }
      return json({});
    }
    if (u.pathname.endsWith("/values:batchClear")) {
      for (const a1 of body.ranges as string[]) {
        const r = parseA1(a1);
        for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) this.set(r.sheet, row, col, "");
      }
      return json({});
    }
    return json({ error: { message: "not found" } }, 404);
  }) as typeof fetch;
}

/** Згенерувати RSA-ключ і зібрати JSON сервісного акаунта, як видає Google. */
export async function makeServiceAccountKey(): Promise<{ raw: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  return {
    raw: JSON.stringify({ type: "service_account", client_email: "bot@test.iam.gserviceaccount.com", private_key: pem }),
    publicKey: pair.publicKey,
  };
}
