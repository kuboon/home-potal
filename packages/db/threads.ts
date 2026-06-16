/**
 * Thread + Message access.
 *
 * Threads live inside a Home; messages live inside a Thread. Membership/role
 * checks are the controller's job — these functions assume the caller is
 * already authorized. `listMessages` includes deleted messages as tombstones.
 */

import { monotonicUlid } from "@std/ulid";
import { db } from "./client.ts";
import { HomeError } from "./homes.ts";

/** Max message length, in characters. */
export const MAX_MESSAGE_LENGTH = 4000;

export interface Thread {
  id: string;
  homeId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
}

/** Summary of the original message a repost references. */
export interface RepostOf {
  authorName: string;
  body: string;
  deleted: boolean;
}

export interface Message {
  id: string;
  threadId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  /** Id of the original message this reposts, or `null`. */
  repostOf: string | null;
  /** The referenced original's summary when this is a repost. */
  repost: RepostOf | null;
}

function rowToThread(row: Record<string, unknown>): Thread {
  return {
    id: String(row.id),
    homeId: String(row.home_id),
    title: String(row.title),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
  };
}

export async function createThread(
  input: { homeId: string; title: string; userId: string },
): Promise<Thread> {
  const title = input.title.trim();
  if (!title) throw new HomeError("title is required");

  const id = monotonicUlid();
  await (await db()).execute({
    sql:
      "INSERT INTO threads (id, home_id, title, created_by) VALUES (?, ?, ?, ?)",
    args: [id, input.homeId, title, input.userId],
  });
  const thread = await getThread(id);
  if (!thread) throw new Error(`createThread failed to read back ${id}`);
  return thread;
}

export async function getThread(id: string): Promise<Thread | null> {
  const { rows } = await (await db()).execute({
    sql: "SELECT * FROM threads WHERE id = ?",
    args: [id],
  });
  return rows[0] ? rowToThread(rows[0]) : null;
}

/** Threads in a home, newest first. */
export async function listThreads(homeId: string): Promise<Thread[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT * FROM threads WHERE home_id = ? ORDER BY created_at DESC",
    args: [homeId],
  });
  return rows.map(rowToThread);
}

export async function postMessage(
  input: { threadId: string; authorId: string; body: string },
): Promise<Message> {
  const body = input.body.trim();
  if (!body) throw new HomeError("message body is required");
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new HomeError(`message too long (max ${MAX_MESSAGE_LENGTH})`);
  }

  const id = monotonicUlid();
  await (await db()).execute({
    sql:
      "INSERT INTO messages (id, thread_id, author_id, body) VALUES (?, ?, ?, ?)",
    args: [id, input.threadId, input.authorId, body],
  });
  const message = await getMessage(id);
  if (!message) throw new Error(`postMessage failed to read back ${id}`);
  return message;
}

// Shared SELECT: message + author, plus the referenced original (for reposts).
const MESSAGE_SELECT = "SELECT m.*, u.display_name, " +
  "o.body AS r_body, o.deleted_at AS r_deleted, ou.display_name AS r_author " +
  "FROM messages m " +
  "JOIN users u ON u.id = m.author_id " +
  "LEFT JOIN messages o ON o.id = m.repost_of " +
  "LEFT JOIN users ou ON ou.id = o.author_id";

async function getMessage(id: string): Promise<Message | null> {
  const { rows } = await (await db()).execute({
    sql: `${MESSAGE_SELECT} WHERE m.id = ?`,
    args: [id],
  });
  return rows[0] ? rowToMessage(rows[0]) : null;
}

function rowToMessage(row: Record<string, unknown>): Message {
  const deleted = row.deleted_at != null;
  const repostOf = row.repost_of == null ? null : String(row.repost_of);
  let repost: RepostOf | null = null;
  if (repostOf && row.r_author != null) {
    const rDeleted = row.r_deleted != null;
    repost = {
      authorName: String(row.r_author),
      body: rDeleted ? "" : String(row.r_body),
      deleted: rDeleted,
    };
  }
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    authorId: String(row.author_id),
    authorName: String(row.display_name),
    // Deleted messages keep a tombstone (the row) but not their content.
    body: deleted ? "" : String(row.body),
    createdAt: String(row.created_at),
    editedAt: row.edited_at == null ? null : String(row.edited_at),
    deleted,
    repostOf,
    repost,
  };
}

/** Messages in a thread, oldest first. Deleted ones remain as tombstones. */
export async function listMessages(threadId: string): Promise<Message[]> {
  const { rows } = await (await db()).execute({
    sql: `${MESSAGE_SELECT} WHERE m.thread_id = ? ORDER BY m.created_at`,
    args: [threadId],
  });
  return rows.map(rowToMessage);
}

/**
 * Repost (pick up) a message into a thread, with an optional comment (`body`).
 * Link flattening: a repost always references the ORIGINAL, so reposting a
 * repost copies its `repost_of` rather than pointing at the repost.
 */
export async function repostMessage(
  input: {
    threadId: string;
    authorId: string;
    sourceMessageId: string;
    body?: string;
  },
): Promise<Message> {
  const source = await getMessage(input.sourceMessageId);
  if (!source) throw new HomeError("source message not found", 404);
  const original = source.repostOf ?? source.id;

  const id = monotonicUlid();
  const body = (input.body ?? "").trim();
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new HomeError(`message too long (max ${MAX_MESSAGE_LENGTH})`);
  }
  await (await db()).execute({
    sql: "INSERT INTO messages (id, thread_id, author_id, body, repost_of) " +
      "VALUES (?, ?, ?, ?, ?)",
    args: [id, input.threadId, input.authorId, body, original],
  });
  const message = await getMessage(id);
  if (!message) throw new Error(`repostMessage failed to read back ${id}`);
  return message;
}

/** Minimal message info for authorization (who/where), or `null`. */
export async function getMessageContext(
  messageId: string,
): Promise<{ threadId: string; homeId: string; authorId: string } | null> {
  const { rows } = await (await db()).execute({
    sql: "SELECT m.thread_id, m.author_id, t.home_id FROM messages m " +
      "JOIN threads t ON t.id = m.thread_id WHERE m.id = ?",
    args: [messageId],
  });
  const row = rows[0];
  if (!row) return null;
  return {
    threadId: String(row.thread_id),
    homeId: String(row.home_id),
    authorId: String(row.author_id),
  };
}

/** Edit a message's body in place and stamp `edited_at`. Author only. */
export async function editMessage(
  input: { messageId: string; authorId: string; body: string },
): Promise<Message> {
  const body = input.body.trim();
  if (!body) throw new HomeError("message body is required");
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new HomeError(`message too long (max ${MAX_MESSAGE_LENGTH})`);
  }
  const result = await (await db()).execute({
    sql: "UPDATE messages SET body = ?, edited_at = datetime('now') " +
      "WHERE id = ? AND author_id = ? AND deleted_at IS NULL",
    args: [body, input.messageId, input.authorId],
  });
  if (result.rowsAffected === 0) {
    throw new HomeError("message not found or not editable", 404);
  }
  const message = await getMessage(input.messageId);
  if (!message) throw new Error("editMessage failed to read back");
  return message;
}

/** Soft-delete a message: clear its body, leave a tombstone. Idempotent. */
export async function deleteMessage(messageId: string): Promise<void> {
  await (await db()).execute({
    sql: "UPDATE messages SET deleted_at = datetime('now'), body = '' " +
      "WHERE id = ? AND deleted_at IS NULL",
    args: [messageId],
  });
}
