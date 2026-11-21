// Access token Google для сервісного акаунта: JWT RS256 через WebCrypto, без бібліотек.
// Токен живе 60 хв; кешуємо в пам'яті воркера і в D1 на 55 хв.

import { cacheGet, cachePut } from "./db";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const CACHE_KEY = "google_token";
const TOKEN_TTL_MS = 55 * 60_000;

export type FetchFn = typeof fetch;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export class GoogleAuthError extends Error {}

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(raw);
  } catch {
    throw new GoogleAuthError("GOOGLE_SA_KEY не є JSON — перевірте секрет");
  }
  if (!key.client_email || !key.private_key) {
    throw new GoogleAuthError("У GOOGLE_SA_KEY немає client_email або private_key");
  }
  return { client_email: key.client_email, private_key: key.private_key };
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const base64urlJson = (obj: unknown) => base64url(encoder.encode(JSON.stringify(obj)));

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der.buffer;
}

/** Підписаний JWT для обміну на access token. */
export async function signJwt(key: ServiceAccountKey, nowSec: number): Promise<string> {
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const claims = base64urlJson({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 });
  const unsigned = `${header}.${claims}`;
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, encoder.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

let memory: { token: string; expiresAt: number } | null = null;

/** Для тестів: забути токен у пам'яті. */
export function resetTokenMemory(): void {
  memory = null;
}

export async function getAccessToken(
  db: D1Database,
  rawKey: string,
  fetchFn: FetchFn = fetch,
  now: number = Date.now(),
): Promise<string> {
  if (memory && memory.expiresAt > now) return memory.token;

  const cached = await cacheGet(db, CACHE_KEY, now);
  if (cached) {
    memory = { token: cached, expiresAt: now + 60_000 }; // точний термін знає D1; у пам'яті — недовго
    return cached;
  }

  const jwt = await signJwt(parseServiceAccountKey(rawKey), Math.floor(now / 1000));
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new GoogleAuthError(`Google не видав токен: ${res.status} ${body.error ?? ""} ${body.error_description ?? ""}`.trim());
  }
  await cachePut(db, CACHE_KEY, body.access_token, TOKEN_TTL_MS, now);
  memory = { token: body.access_token, expiresAt: now + TOKEN_TTL_MS };
  return body.access_token;
}
