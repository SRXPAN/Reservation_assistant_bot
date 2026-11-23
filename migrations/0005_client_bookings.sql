-- Прив'язка клієнтських броней (ID з колонки U) до Telegram ID клієнта.
CREATE TABLE client_bookings (
  booking_id   TEXT    PRIMARY KEY,
  client_tg_id INTEGER NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_client_bookings_user ON client_bookings (client_tg_id, status);

-- Стан покрокового майстра самозапису клієнта в особистих повідомленнях.
CREATE TABLE client_sessions (
  user_id    INTEGER PRIMARY KEY,
  message_id INTEGER,
  step       TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
