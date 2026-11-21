// Завантажити секрет у Cloudflare зі значення в .dev.vars — через stdin, без виводу на екран.
//   node scripts/put-secret.mjs GOOGLE_SA_KEY
//   node scripts/put-secret.mjs WEBHOOK_SECRET
//   node scripts/put-secret.mjs WEBHOOK_SECRET --generate   — спершу згенерувати випадковий і вписати в .dev.vars
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const name = process.argv[2];
if (!name) {
  console.error("Вкажіть назву секрету, напр.: node scripts/put-secret.mjs BOT_TOKEN");
  process.exit(1);
}

let lines = readFileSync(".dev.vars", "utf8").split(/\r?\n/);
if (process.argv.includes("--generate")) {
  const value = randomBytes(32).toString("hex");
  const at = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (at >= 0) lines[at] = `${name}=${value}`;
  else lines.splice(lines.length - (lines.at(-1) === "" ? 1 : 0), 0, `${name}=${value}`);
  writeFileSync(".dev.vars", lines.join("\n"));
  console.log(`${name}: згенеровано і вписано в .dev.vars`);
}

lines = readFileSync(".dev.vars", "utf8").split(/\r?\n/);
const line = lines.find((l) => l.startsWith(`${name}=`));
let value = line ? line.slice(name.length + 1).trim() : "";
if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
if (!value) {
  console.error(`У .dev.vars немає значення ${name}`);
  process.exit(1);
}

const child = spawn("npx.cmd", ["wrangler", "secret", "put", name], { stdio: ["pipe", "inherit", "inherit"], shell: true });
child.stdin.end(value);
child.on("exit", (code) => process.exit(code ?? 1));
