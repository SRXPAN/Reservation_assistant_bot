-- Короткоживучі значення: access token Google, налаштування з таблиці (ПК, години).
CREATE TABLE cache (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  expires_at INTEGER NOT NULL               -- мс від епохи (Date.now())
);

-- Замки: два адміни одночасно не мають отримати один і той самий вільний рядок таблиці.
CREATE TABLE locks (
  name       TEXT    PRIMARY KEY,
  holder     TEXT    NOT NULL,
  expires_at INTEGER NOT NULL               -- мс від епохи; прострочений замок можна перехопити
);
