// Доступ до таблиць D1: прив'язка гілки, картки, ForceReply-запити, журнал.

import type { Draft } from "./parse";

export interface Binding {
  chat_id: number;
  thread_id: number | null;
  menu_message_id?: number | null;
}

export async function getBinding(db: D1Database): Promise<Binding | null> {
  const row = await db.prepare("SELECT value FROM kv WHERE key = 'binding'").first<{ value: string }>();
  return row ? (JSON.parse(row.value) as Binding) : null;
}

export async function setBinding(db: D1Database, b: Binding): Promise<void> {
  await db
    .prepare("INSERT INTO kv (key, value) VALUES ('binding', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(b))
    .run();
}

export type CardState = "draft" | "saving" | "saved" | "editing" | "cancelled" | "deleting" | "deleted";

export interface CardRow {
  id: string;
  chat_id: number;
  thread_id: number | null;
  message_id: number | null;
  source_message_id: number | null;
  state: CardState;
  data: string;
  body: string;
  kb: string | null;
  bot_ok: number | null;
  saved_data: string | null;
  saved_body: string | null;
  rows: string | null;
  k_status: string | null;
  verify_pending: number;
  created_by: number;
  created_by_name: string;
  saved_by_name: string | null;
  saved_at: string | null;
  closed_by_name: string | null;
  closed_at: string | null;
  error: string | null;
}

export const draftOf = (card: CardRow): Draft => JSON.parse(card.data) as Draft;

export async function createCard(
  db: D1Database,
  c: { id: string; chat_id: number; thread_id: number | null; source_message_id: number | null; data: Draft; body: string; user_id: number; user_name: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cards (id, chat_id, thread_id, source_message_id, state, data, body, created_by, created_by_name)
       VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?6, ?7, ?8)`,
    )
    .bind(c.id, c.chat_id, c.thread_id, c.source_message_id, JSON.stringify(c.data), c.body, c.user_id, c.user_name)
    .run();
}

export async function getCard(db: D1Database, id: string): Promise<CardRow | null> {
  return db.prepare("SELECT * FROM cards WHERE id = ?1").bind(id).first<CardRow>();
}

type Patch = Partial<Omit<CardRow, "id">>;

/** Оновити поля картки; з `onlyIn` — лише якщо картка зараз у одному з цих станів (захист від подвійних натискань). */
export async function updateCard(db: D1Database, id: string, patch: Patch, onlyIn?: CardState[]): Promise<boolean> {
  const keys = Object.keys(patch) as (keyof Patch)[];
  const sets = keys.map((k, i) => `${k} = ?${i + 2}`).join(", ");
  const values = keys.map((k) => patch[k] ?? null);
  let sql = `UPDATE cards SET ${sets}, updated_at = datetime('now') WHERE id = ?1`;
  if (onlyIn?.length) sql += ` AND state IN (${onlyIn.map((s) => `'${s}'`).join(", ")})`;
  const res = await db.prepare(sql).bind(id, ...values).run();
  return (res.meta.changes ?? 0) === 1;
}

export async function pendingVerifications(db: D1Database, limit = 3): Promise<CardRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM cards WHERE verify_pending = 1 ORDER BY updated_at LIMIT ?1")
    .bind(limit)
    .all<CardRow>();
  return results;
}

export async function createPrompt(db: D1Database, p: { chat_id: number; message_id: number; card_id: string | null; field: string; user_id: number }) {
  await db
    .prepare("INSERT OR REPLACE INTO prompts (chat_id, message_id, card_id, field, user_id) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(p.chat_id, p.message_id, p.card_id, p.field, p.user_id)
    .run();
}

export async function takePrompt(db: D1Database, chatId: number, messageId: number) {
  const row = await db
    .prepare("SELECT * FROM prompts WHERE chat_id = ?1 AND message_id = ?2")
    .bind(chatId, messageId)
    .first<{ card_id: string | null; field: string; user_id: number }>();
  if (row) await db.prepare("DELETE FROM prompts WHERE chat_id = ?1 AND message_id = ?2").bind(chatId, messageId).run();
  return row;
}

export interface AuditRow {
  at: string;
  user_name: string | null;
  action: string;
  card_id: string | null;
  details: string | null;
}

export async function recentAudit(db: D1Database, limit = 25): Promise<AuditRow[]> {
  const { results } = await db
    .prepare("SELECT at, user_name, action, card_id, details FROM audit_log ORDER BY id DESC LIMIT ?1")
    .bind(limit)
    .all<AuditRow>();
  return results;
}

export async function audit(
  db: D1Database,
  e: { user_id?: number | null; user_name?: string | null; action: string; card_id?: string | null; details?: unknown },
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (user_id, user_name, action, card_id, details) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(e.user_id ?? null, e.user_name ?? null, e.action, e.card_id ?? null, e.details === undefined ? null : JSON.stringify(e.details))
    .run();
}
