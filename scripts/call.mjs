// Виклик службових маршрутів воркера із секретом у заголовку. Бере WORKER_URL і WEBHOOK_SECRET з .dev.vars.
// Секрет не потрапляє ні в адресу, ні на екран.
//   npm run bot:setup    — зареєструвати вебхук і команди
//   npm run bot:status   — що Telegram знає про вебхук
import { readFileSync } from "node:fs";

const route = process.argv[2];
if (!route?.startsWith("/")) {
  console.error("Вкажіть маршрут, напр.: node scripts/call.mjs /status");
  process.exit(1);
}

const vars = {};
for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
  const eq = line.indexOf("=");
  if (eq > 0 && !line.startsWith("#")) vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}
if (!vars.WORKER_URL || !vars.WEBHOOK_SECRET) {
  console.error("У .dev.vars мають бути рядки WORKER_URL=https://... і WEBHOOK_SECRET=...");
  process.exit(1);
}

const res = await fetch(vars.WORKER_URL.replace(/\/$/, "") + route, {
  headers: { "X-Telegram-Bot-Api-Secret-Token": vars.WEBHOOK_SECRET },
});
const body = await res.text();
console.log(`${res.status} ${res.statusText}`);
try {
  console.log(JSON.stringify(JSON.parse(body), null, 2));
} catch {
  console.log(body);
}
process.exit(res.ok ? 0 : 1);
