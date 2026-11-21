-- Прості налаштування бота: прив'язана гілка тощо.
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Картка броні: зв'язок «ID броні (колонка U) ↔ повідомлення з карткою» і її стан.
CREATE TABLE cards (
  id                TEXT    PRIMARY KEY,            -- ID броні, той самий, що піде в колонку U
  chat_id           INTEGER NOT NULL,
  thread_id         INTEGER,                        -- гілка (message_thread_id)
  message_id        INTEGER,                        -- повідомлення з карткою
  source_message_id INTEGER,                        -- повідомлення адміна, на яке відповідає картка
  state             TEXT    NOT NULL
                    CHECK (state IN ('draft', 'saving', 'saved', 'editing', 'cancelled', 'deleting', 'deleted')),
  data              TEXT    NOT NULL,               -- JSON чернетки (поточні значення)
  body              TEXT    NOT NULL DEFAULT '',    -- HTML полів і перевірки для поточних значень
  kb                TEXT,                           -- JSON головних кнопок картки (для «↩️ Назад»)
  bot_ok            INTEGER,                        -- 1 — бот вважав, що все гаразд (для звірки з K)
  saved_data        TEXT,                           -- JSON того, що записано в таблицю
  saved_body        TEXT,
  rows              TEXT,                           -- JSON номерів рядків у таблиці
  k_status          TEXT,                           -- статус K з таблиці після запису
  verify_pending    INTEGER NOT NULL DEFAULT 0,     -- 1 — ще не перечитали K (дочитає Cron)
  created_by        INTEGER NOT NULL,
  created_by_name   TEXT    NOT NULL,
  saved_by_name     TEXT,
  saved_at          TEXT,
  closed_by_name    TEXT,                           -- хто відмінив/скасував
  closed_at         TEXT,
  error             TEXT,                           -- остання помилка запису (показується в картці)
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cards_verify ON cards (verify_pending) WHERE verify_pending = 1;

-- Запити ForceReply «введіть нове значення»: відповідь на повідомлення → яке поле якої картки.
CREATE TABLE prompts (
  chat_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  card_id    TEXT    NOT NULL REFERENCES cards (id),
  field      TEXT    NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, message_id)
);

-- Журнал: хто, коли, що.
CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT    NOT NULL DEFAULT (datetime('now')),
  user_id   INTEGER,
  user_name TEXT,
  action    TEXT    NOT NULL,
  card_id   TEXT,
  details   TEXT
);
CREATE INDEX idx_audit_card ON audit_log (card_id);
