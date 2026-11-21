-- Надіслані нагадування і зведення: ключ гарантує «без дублів» (ставимо ДО відправки,
-- при помилці Telegram — видаляємо, щоб наступний запуск Cron спробував ще раз).
CREATE TABLE sent_reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL UNIQUE,              -- r:<ID>:<початок> / r:m:… (ручна бронь) / s:<день>
  kind        TEXT    NOT NULL CHECK (kind IN ('reminder', 'summary')),
  booking_id  TEXT,                                 -- ID бота (колонка U); NULL — ручна бронь
  target      TEXT,                                 -- JSON для пошуку ручної броні: дата, від, ПК, ім'я
  text        TEXT,                                 -- текст нагадування (щоб дописати відмітку)
  chat_id     INTEGER,
  message_id  INTEGER,
  attendance  TEXT    CHECK (attendance IN ('came', 'no_show')),
  marked_by   TEXT,
  marked_at   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sent_created ON sent_reminders (created_at);
