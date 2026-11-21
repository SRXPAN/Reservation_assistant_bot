# Бот «Бронювання ПК»

Telegram-бот для гілки «Reservation» робочої групи клубу. Адміністратор пише бронь звичайним повідомленням —
бот показує картку з перевіркою (вільно / накладка / поза годинами / у минулому) і після ✅ записує бронь
у Google Таблицю. Таблиця — головне джерело даних: бот щоразу читає її свіжою, люди можуть правити її вручну.

Повне ТЗ і всі ухвалені рішення — у [SPEC.md](SPEC.md).

- Воркер: `club-reservation-bot` → https://club-reservation-bot.nanox-krakow.workers.dev
- База D1: `club-reservations`
- Таблиця: https://docs.google.com/spreadsheets/d/1ZTh4vIN7AEc49d4y3xXlZjB3TpM2VIuYxyh7_N2pvKc/edit
- Сервісний акаунт Google: `reservation-bot@sincere-tape-515221-j9.iam.gserviceaccount.com` (роль «Редактор» у таблиці)

> Windows: PowerShell блокує `npx.ps1`, тому скрізь `npx.cmd …` (або `cmd /c npx …`). `npm run …` працює як є.

## Як користуватися (для адміністраторів)

Пишіть бронь одним повідомленням у гілці «Reservation»:

```
пт 18 пк 12-17 з 19 до 2 Vova tg
21.11 ПК 18 16:00-19:00 Андрій +48 501 234 567
завтра 12-14 пк, 18:00–22:00, Олег, insta, день народження
сьогодні 5 пк на 3 години з 20:00 Марта 0671234567
```

- Бот відповідає карткою. У таблицю нічого не потрапляє без натискання **✅ Записати**.
- Якщо щось не так (накладка, поза годинами, час минув) — замість «Записати» буде **⚠ Записати попри …** з підтвердженням.
- **✏️ Змінити** → вибрати поле → написати нове значення у відповідь на запит бота.
- На записаній картці: **✏️ Змінити**, **🗑 Скасувати бронь**, **📄 Таблиця**.
- Закріплене меню: **📅 Сьогодні**, **📅 Завтра**, **🟢 Вільні зараз**, **🔎 Пошук**, **➕ Бронь кнопками**, **📄 Таблиця**.
- За 30 хв до початку — нагадування з **✅ Прийшов / ❌ Не прийшов** (відмітка йде в «Примітку»). Щодня в годину відкриття — зведення дня.
- Звичайну переписку бот ігнорує. Працює лише в прив'язаній гілці.
- Власнику: `/log` — останні 25 дій (хто, коли, що); `/start` у гілці — оновити закріплене меню.

## Перший запуск з нуля

Усе нижче вже зроблено для робочого бота; розділ — на випадок переїзду на інший акаунт або нового бота.

```powershell
npm install
npx.cmd wrangler login                                  # той самий акаунт Cloudflare, що й у бота оплат
npx.cmd wrangler d1 create club-reservations            # database_id → wrangler.toml
npm run db:migrate                                      # міграції в робочу базу
npm run deploy

# Секрети (вміст на екран не виводиться):
npx.cmd wrangler secret put BOT_TOKEN                   # вставити токен від @BotFather
npm run secret:webhook                                  # згенерувати WEBHOOK_SECRET, вписати в .dev.vars і в Cloudflare
npx.cmd wrangler secret put GOOGLE_SA_KEY < "C:\Users\vadek\Desktop\DONT TOUCH\<файл>.json"   # у cmd; у Git Bash — те саме з /c/Users/...
```

Далі:

1. У `.dev.vars` (є шаблон `.dev.vars.example`) мають бути `WORKER_URL=https://club-reservation-bot.nanox-krakow.workers.dev` і `WEBHOOK_SECRET`.
2. `npm run bot:setup` — реєструє вебхук і команди. Рядок `bot_info` з відповіді вписати в `BOT_INFO` у `wrangler.toml` і ще раз `npm run deploy` (бот не викликатиме `getMe` на кожне повідомлення).
3. `npm run bot:status` — має бути `telegram.url` без `last_error_message` і `sheet.ok: true`.
4. Бота — в групу адміністратором з правами **«Закріплювати повідомлення»** і **«Видаляти повідомлення»** (щоб прибирати свої запити й відповіді на них).
5. Власник (OWNER_ID у `wrangler.toml`) пише `/start` у гілці «Reservation» → **Так**. Бот запам'ятовує гілку і закріплює меню.

Для локальних живих тестів ключ у `.dev.vars` вписує `npm run devvars:key` (читає .json з «DONT TOUCH», нічого не друкує).
**Ключ ніколи не копіювати в папку проєкту і не комітити.** `.dev.vars` — у `.gitignore`.

## Оновлення

```powershell
npm test                 # 165 тестів, без мережі
npm run typecheck
npm run deploy
```

Якщо додано нову міграцію (`migrations/000N_….sql`):

```powershell
npx.cmd wrangler d1 export club-reservations --remote --output backup-before-000N.sql   # спершу бекап
npm run db:migrate
npm run deploy
```

Після змін у роботі з таблицею варто прогнати живу перевірку:

```powershell
npm run test:live
```

Вона записує 3 тестові броні на наступний тиждень (рядки «ТЕСТ бот …»), звіряє колонку K і розклади «Вт»/«Пт»
з перевіркою бота, **на кілька секунд ставить у B3 дату наступного тижня** (аркуші днів показують лише вибраний тиждень),
потім повертає `=TODAY()` і видаляє тестові рядки. Займає ~2 хв (див. «Ліміти» → перерахунок таблиці).

### Ротація ключа Google

Google Cloud → IAM → Service Accounts → `reservation-bot` → Keys → Add key (JSON) → покласти в «DONT TOUCH» →
`npx.cmd wrangler secret put GOOGLE_SA_KEY < "…\новий.json"` → `npm run devvars:key` → `npm run bot:status` (`sheet.ok: true`) → видалити старий ключ у Google Cloud.

## Логи і діагностика

- **`npm run bot:status`** — вебхук (останні помилки Telegram), доступ до таблиці, прив'язана гілка, скільки статусів K чекають дочитування.
- **`npm run bot:check`** — вручну запустити те, що робить Cron (нагадування, зведення, статуси K). Дублів не буде.
- **Логи воркера:** дашборд Cloudflare → Workers & Pages → `club-reservation-bot` → **Logs** (збереження ввімкнене в `wrangler.toml`), або наживо:
  ```powershell
  npx.cmd wrangler tail club-reservation-bot --format pretty
  ```
  Шукайте «Помилка», «Розбіжність перевірки» (бот і колонка K не згодні), «Нагадування не надіслано».
- **Журнал дій** у Telegram: `/log` (власник). Повний — у D1:
  ```powershell
  npx.cmd wrangler d1 execute club-reservations --remote --command "SELECT at, user_name, action, card_id, details FROM audit_log ORDER BY id DESC LIMIT 50"
  ```
  Час у журналі — UTC.

Типові проблеми:

| Симптом | Причина / що робити |
|---|---|
| Бот мовчить у гілці | `bot:status`: чи є `binding`, чи немає `last_error_message`. Бот має бути адміністратором. Повідомлення без ознак броні бот ігнорує навмисно. |
| Картка «⏳ Перевіряю таблицю…» кілька секунд | Нормально: після будь-якої зміни таблиця ~17 с перераховує формули, і Google не віддає дані до кінця перерахунку. |
| «статус таблиці: ⏳ перевіряю…» | Статус K дочитає Cron протягом 5 хв (або `npm run bot:check`). |
| «❗ Не вдалося прочитати таблицю» | Google тимчасово не відповів — кнопка **🔄 Перевірити ще раз**. Якщо повторюється — `bot:status` → `sheet.error`. |
| Меню не закріпилось | Немає права «Закріплювати повідомлення». Дати право і написати `/start` у гілці. |
| `sheet.error` про доступ | Сервісному акаунту прибрали доступ до таблиці — повернути роль «Редактор». |

## Бекап

- **База D1** (картки, журнал, нагадування, прив'язка гілки):
  ```powershell
  npx.cmd wrangler d1 export club-reservations --remote --output backup-2026-11-20.sql
  ```
  Відновлення в порожню базу: `npx.cmd wrangler d1 execute club-reservations --remote --file backup-2026-11-20.sql`.
  Файли `backup*.sql` — у `.gitignore`. Cloudflare також зберігає 30 днів історії D1 (Time Travel): `npx.cmd wrangler d1 time-travel info club-reservations`.
- **Google Таблиця** (головні дані — самі броні): **Файл → Завантажити → Microsoft Excel (.xlsx)**. Плюс вбудована історія: **Файл → Історія версій**.
  Бронь, відновлена в таблиці разом із колонкою U, знову «прив'язується» до картки бота за ID.

## Ліміти (безкоштовні плани, станом на листопад 2026)

| Що | Ліміт | Скільки бере бот |
|---|---|---|
| Workers: запити | 100 000 / добу | одне повідомлення чи натискання = 1 запит; Cron = 288 / добу |
| Workers: CPU | 10 мс на виклик | бот легкий: важка лише підпис JWT для Google раз на ~55 хв |
| Workers: фонова робота (`waitUntil`) | до 30 с після відповіді | бот закладає 27 с; що не встиг — доробляє Cron |
| Cron Triggers | 5 на акаунт | цей бот — 1 (`*/5 * * * *`), бот оплат — 1 |
| D1 | 5 ГБ, 5 млн читань і 100 тис. записів рядків / добу | десятки–сотні на день |
| Workers AI | 10 000 нейронів / добу | запасний розбір лише для «важких» повідомлень, бот сам обмежує 60 викликами на добу |
| Google Sheets API | 60 запитів / хв на сервісний акаунт | Cron — 1 читання за 5 хв; кожна дія — 1–3 запити |
| Telegram | ~20 повідомлень / хв у групу | з запасом |
| Таблиця | рядки 10–1009 (формули I–T протягнуті до 1009) | ~1000 броней; коли вільних рядків не лишиться, бот не запише і скаже про це |

Особливість таблиці: після **будь-якої** зміни Google ~17 с перераховує формули аркушів днів і колонки K,
і перше читання чекає цього перерахунку. Тому бот відповідає Telegram одразу, а з таблицею працює у фоні.

## Будова

```
src/
  index.ts      вебхук (відповідь одразу, обробка у фоні), /setup, /status, /run-check, Cron
  bot.ts        grammY: прив'язка гілки, фільтр «лише своя гілка», маршрути
  flow.ts       картки броні, «Бронь кнопками», меню, журнал
  reminders.ts  виконання нагадувань/зведень, «Прийшов / Не прийшов»
  notify.ts     «що надіслати зараз» — чиста функція
  parse.ts      детермінований розбір тексту          ai.ts  запасний розбір Workers AI
  check.ts      перевірка чернетки                     card.ts  текст картки і кнопки
  bookings.ts   рядки таблиці, групи ПК, накладки, статус «як K»
  hours.ts      години роботи (як Sched_S/Sched_E таблиці)   time.ts  серійні дати, Europe/Warsaw
  views.ts      «Сьогодні / Завтра / Вільні / Пошук»
  sheet.ts      Google Sheets: batchGet, запис під замком, пошук за ID   google.ts  JWT RS256
  store.ts, db.ts  D1: картки, запити, журнал, кеш, замок
migrations/     схема D1
test/           Vitest (без мережі); test/live — жива перевірка на таблиці
scripts/        call.mjs (службові маршрути з секретом), put-secret.mjs, devvars-key.mjs
```

| Команда | Що робить |
|---|---|
| `npm test` / `npm run typecheck` | тести / перевірка типів |
| `npm run test:live` | жива перевірка на таблиці (див. вище) |
| `npm run deploy` | задеплоїти воркер |
| `npm run db:migrate` | міграції в робочу D1 |
| `npm run bot:setup` / `bot:status` / `bot:check` | вебхук / стан / ручний запуск Cron |
| `npm run secret:webhook` / `secret:token` / `secret:key` | секрети з `.dev.vars` у Cloudflare |
| `npm run devvars:key` | ключ Google з «DONT TOUCH» у `.dev.vars` |
