// Вписує JSON-ключ сервісного акаунта в .dev.vars як GOOGLE_SA_KEY (для локального запуску і живих тестів).
// Ключ не копіюється в проєкт окремим файлом і не виводиться на екран — друкуємо лише client_email.
//   npm run devvars:key                      — шукає єдиний .json у "C:\Users\vadek\Desktop\DONT TOUCH"
//   node scripts/devvars-key.mjs "<папка>"   — інша папка
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "C:\\Users\\vadek\\Desktop\\DONT TOUCH";
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json"));
if (files.length !== 1) {
  console.error(`У папці має бути рівно один .json, знайдено: ${files.length}`);
  process.exit(1);
}

let key;
try {
  key = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
} catch {
  console.error("Файл ключа не є коректним JSON");
  process.exit(1);
}
if (key.type !== "service_account" || !key.client_email || !String(key.private_key ?? "").includes("PRIVATE KEY")) {
  console.error("Це не ключ сервісного акаунта (немає type/client_email/private_key)");
  process.exit(1);
}

// Один рядок; \n у private_key лишаються екранованими всередині JSON.
const value = JSON.stringify(key);
if (value.includes("'")) {
  console.error("У ключі є апостроф — такий рядок не можна взяти в одинарні лапки в .dev.vars");
  process.exit(1);
}

const gitignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
if (!/^\.dev\.vars$/m.test(gitignore)) {
  console.error(".dev.vars не в .gitignore — спершу додайте його, ключ не записано");
  process.exit(1);
}

const lines = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8").split(/\r?\n/) : [];
const line = `GOOGLE_SA_KEY='${value}'`;
const at = lines.findIndex((l) => l.startsWith("GOOGLE_SA_KEY="));
if (at >= 0) lines[at] = line;
else lines.push(line);
writeFileSync(".dev.vars", lines.filter((l, i) => l !== "" || i < lines.length - 1).join("\n") + "\n");

console.log(`GOOGLE_SA_KEY записано в .dev.vars (${at >= 0 ? "оновлено" : "додано"}), сервісний акаунт: ${key.client_email}`);
