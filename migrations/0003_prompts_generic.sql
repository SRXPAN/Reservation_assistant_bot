-- Запити ForceReply тепер бувають і без картки (🔎 Пошук), тому card_id може бути порожнім.
CREATE TABLE prompts_new (
  chat_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  card_id    TEXT,                                -- NULL — запит меню (напр. пошук)
  field      TEXT    NOT NULL,                    -- date / pcs / … ; w:… — крок «Броні кнопками»; search
  user_id    INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, message_id)
);
INSERT INTO prompts_new (chat_id, message_id, card_id, field, user_id, created_at)
  SELECT chat_id, message_id, card_id, field, user_id, created_at FROM prompts;
DROP TABLE prompts;
ALTER TABLE prompts_new RENAME TO prompts;

CREATE INDEX idx_audit_at ON audit_log (at);
