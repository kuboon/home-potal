/**
 * Thread + Message access.
 *
 * Threads live inside a Home; messages live inside a Thread. Membership/role
 * checks are the controller's job — these functions assume the caller is
 * already authorized. `listMessages` returns only live (non-deleted) messages.
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

export interface Message {
  id: string;
  threadId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
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

async function getMessage(id: string): Promise<Message | null> {
  const { rows } = await (await db()).execute({
    sql: "SELECT m.*, u.display_name FROM messages m " +
      "JOIN users u ON u.id = m.author_id WHERE m.id = ?",
    args: [id],
  });
  return rows[0] ? rowToMessage(rows[0]) : null;
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    authorId: String(row.author_id),
    authorName: String(row.display_name),
    body: String(row.body),
    createdAt: String(row.created_at),
    editedAt: row.edited_at == null ? null : String(row.edited_at),
  };
}

/** Live (non-deleted) messages in a thread, oldest first. */
export async function listMessages(threadId: string): Promise<Message[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT m.*, u.display_name FROM messages m " +
      "JOIN users u ON u.id = m.author_id " +
      "WHERE m.thread_id = ? AND m.deleted_at IS NULL " +
      "ORDER BY m.created_at",
    args: [threadId],
  });
  return rows.map(rowToMessage);
}

/**
 * Live messages newer than `afterId`, oldest first. Message ids are ULIDs, so
 * `id > afterId` is a time-ordered "since" filter. Pass `""` for all. Used by
 * the realtime stream to fetch only what a client hasn't seen yet.
 */
export async function listMessagesAfter(
  threadId: string,
  afterId: string,
): Promise<Message[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT m.*, u.display_name FROM messages m " +
      "JOIN users u ON u.id = m.author_id " +
      "WHERE m.thread_id = ? AND m.deleted_at IS NULL AND m.id > ? " +
      "ORDER BY m.created_at",
    args: [threadId, afterId],
  });
  return rows.map(rowToMessage);
}
