import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GoogleAuthError, getAccessToken, parseServiceAccountKey, resetTokenMemory, signJwt } from "../src/google";
import { FakeGoogle, makeServiceAccountKey } from "./fakeSheets";
import { fakeD1 } from "./helpers";

let key: Awaited<ReturnType<typeof makeServiceAccountKey>>;
beforeAll(async () => {
  key = await makeServiceAccountKey();
});
beforeEach(() => resetTokenMemory());

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("JWT для сервісного акаунта", () => {
  it("RS256: правильні заголовок, claims і підпис", async () => {
    const jwt = await signJwt(parseServiceAccountKey(key.raw), 1_763_500_000);
    const [h, c, s] = jwt.split(".");
    expect(decode(h!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(c!)).toEqual({
      iss: "bot@test.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_763_500_000,
      exp: 1_763_503_600,
    });
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key.publicKey,
      Buffer.from(s!, "base64url"),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });

  it("зрозуміла помилка на зіпсований ключ", () => {
    expect(() => parseServiceAccountKey("не json")).toThrow(GoogleAuthError);
    expect(() => parseServiceAccountKey("{}")).toThrow(/client_email/);
  });
});

describe("access token", () => {
  it("кешується в D1 ~55 хв: новий воркер (порожня пам'ять) бере його з D1", async () => {
    const google = new FakeGoogle();
    const db = fakeD1();
    const t0 = 1_763_500_000_000;
    expect(await getAccessToken(db, key.raw, google.fetch, t0)).toBe("token-1");
    resetTokenMemory();
    expect(await getAccessToken(db, key.raw, google.fetch, t0 + 54 * 60_000)).toBe("token-1");
    expect(google.tokenRequests).toBe(1);

    resetTokenMemory();
    expect(await getAccessToken(db, key.raw, google.fetch, t0 + 56 * 60_000)).toBe("token-2");
    expect(google.tokenRequests).toBe(2);
  });

  it("помилка Google — з причиною", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }), { status: 400 })) as typeof fetch;
    await expect(getAccessToken(fakeD1(), key.raw, failing)).rejects.toThrow(/400 invalid_grant Invalid JWT Signature/);
  });
});
