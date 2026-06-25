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
import {
  type Channel,
  reactionsByMessage,
  type ReactionSummary,
} from "./reactions.ts";
import { joinedThreadIds, joinThread } from "./participants.ts";

/** Max message length, in characters. */
export const MAX_MESSAGE_LENGTH = 4000;

export interface Thread {
  id: string;
  homeId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  lastPostAt: string;
  archivedAt: string | null;
}

/** A thread plus whether the viewing user is currently joined to it. */
export interface ThreadForViewer extends Thread {
  joined: boolean;
}

/** Summary of the original message a repost references. */
export interface RepostOf {
  authorName: string;
  body: string;
  deleted: boolean;
}

/** A thread that quotes (reposts) a given post — for the bidirectional link. */
export interface QuoteRef {
  threadId: string;
  title: string;
}

export interface Message {
  id: string;
  homeId: string;
  /** The thread this belongs to, or `null` for a home's main channel. */
  threadId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  /** 'normal' post, a 'repost' (quote of an original), or an 'edit' marker. */
  kind: "normal" | "repost" | "edit";
  /** Shown as a deletion to the viewer (author tombstone, or hidden to non-admins). */
  deleted: boolean;
  /** Admin moderation: hidden from non-admins. True only when the viewer is an admin. */
  hidden: boolean;
  /** repost → the original it quotes; edit marker → the newer version. */
  repostOf: string | null;
  /** The referenced original's summary when this is a repost. */
  repost: RepostOf | null;
  /** Threads that quote (repost) this post — the bidirectional "quoted in" link. */
  quotedIn: QuoteRef[];
  /** Aggregated reactions (populated by `listMessages`). */
  reactions: ReactionSummary[];
}

function rowToThread(row: Record<string, unknown>): Thread {
  return {
    id: String(row.id),
    homeId: String(row.home_id),
    title: String(row.title),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    lastPostAt: String(row.last_post_at ?? row.created_at),
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
    sql: "INSERT INTO threads (id, home_id, title, created_by, last_post_at) " +
      "VALUES (?, ?, ?, ?, datetime('now'))",
    args: [id, input.homeId, title, input.userId],
  });
  // The creator is the first participant (empty thread: creator only).
  await joinThread(id, input.userId);
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

/** Days of inactivity (no posts) after which a thread auto-archives. */
export const ARCHIVE_AFTER_DAYS = 7;

/**
 * Archive threads in a home with no activity for {@link ARCHIVE_AFTER_DAYS}.
 * "Activity" is the latest message time, or the thread's creation time if it
 * has none. Run lazily before listing so archiving needs no cron.
 */
export async function archiveStaleThreads(homeId: string): Promise<void> {
  const client = await db();
  await client.execute({
    sql: "UPDATE threads SET archived_at = datetime('now') " +
      "WHERE home_id = ? AND archived_at IS NULL AND " +
      `COALESCE(last_post_at, created_at) < datetime('now', '-${ARCHIVE_AFTER_DAYS} days')`,
    args: [homeId],
  });
  // Archiving drops everyone out of the thread: no more notifications.
  await client.execute({
    sql: "UPDATE thread_participants SET state = 'left', " +
      "updated_at = datetime('now') WHERE state = 'joined' AND thread_id IN (" +
      "SELECT id FROM threads WHERE home_id = ? AND archived_at IS NOT NULL)",
    args: [homeId],
  });
}

/** Threads in a home, newest first. Auto-archives stale ones first. */
export async function listThreads(homeId: string): Promise<Thread[]> {
  await archiveStaleThreads(homeId);
  const { rows } = await (await db()).execute({
    sql: "SELECT * FROM threads WHERE home_id = ? ORDER BY created_at DESC",
    args: [homeId],
  });
  return rows.map(rowToThread);
}

/** Threads in a home tagged with whether `viewerId` is joined to each. */
export async function listThreadsForViewer(
  homeId: string,
  viewerId: string,
): Promise<ThreadForViewer[]> {
  const [threads, joined] = await Promise.all([
    listThreads(homeId),
    joinedThreadIds(homeId, viewerId),
  ]);
  return threads.map((t) => ({ ...t, joined: joined.has(t.id) }));
}

/** Mark a thread active now and ensure `userId` is a joined participant. */
async function touchThread(threadId: string, userId: string): Promise<void> {
  await (await db()).execute({
    sql: "UPDATE threads SET last_post_at = datetime('now') WHERE id = ?",
    args: [threadId],
  });
  await joinThread(threadId, userId);
}

/** Throw if the thread is archived (read-only) or missing. */
async function assertWritable(threadId: string): Promise<void> {
  const thread = await getThread(threadId);
  if (!thread) throw new HomeError("thread not found", 404);
  if (thread.archivedAt) {
    throw new HomeError("スレッドはアーカイブ済みです", 409);
  }
}

export async function postMessage(
  input: {
    homeId: string;
    /** Omit (or `null`) to post to the home's main channel. */
    threadId?: string | null;
    authorId: string;
    body: string;
  },
): Promise<Message> {
  const body = input.body.trim();
  if (!body) throw new HomeError("message body is required");
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new HomeError(`message too long (max ${MAX_MESSAGE_LENGTH})`);
  }
  if (input.threadId) await assertWritable(input.threadId);

  const id = monotonicUlid();
  await (await db()).execute({
    sql: "INSERT INTO messages (id, home_id, thread_id, author_id, body) " +
      "VALUES (?, ?, ?, ?, ?)",
    args: [id, input.homeId, input.threadId ?? null, input.authorId, body],
  });
  // Posting into a thread joins (or re-joins) the author and keeps it active.
  if (input.threadId) await touchThread(input.threadId, input.authorId);
  const message = await getMessage(id);
  if (!message) throw new Error(`postMessage failed to read back ${id}`);
  return message;
}

// Shared SELECT: message + author, plus the referenced original (for reposts).
const MESSAGE_SELECT = "SELECT m.*, u.display_name, " +
  "o.body AS r_body, o.tombstone_at AS r_tombstone, o.hidden_at AS r_hidden, " +
  "ou.display_name AS r_author " +
  "FROM messages m " +
  "JOIN users u ON u.id = m.author_id " +
  "LEFT JOIN messages o ON o.id = m.ref_post_id " +
  "LEFT JOIN users ou ON ou.id = o.author_id";

async function getMessage(
  id: string,
  viewerIsAdmin = false,
): Promise<Message | null> {
  const { rows } = await (await db()).execute({
    sql: `${MESSAGE_SELECT} WHERE m.id = ?`,
    args: [id],
  });
  return rows[0] ? rowToMessage(rows[0], viewerIsAdmin) : null;
}

/**
 * Map a row to a Message, applying moderation visibility for the viewer:
 * - tombstone (author delete): body destroyed for everyone.
 * - hidden (admin moderation): body kept, but only admins can read it;
 *   to everyone else it looks like a deletion.
 * A repost's preview reads "[deleted]" whenever the original is hidden OR
 * tombstoned — even to admins (the preview never reveals moderated content).
 */
function rowToMessage(
  row: Record<string, unknown>,
  viewerIsAdmin: boolean,
): Message {
  const kind = (String(row.kind ?? "normal")) as Message["kind"];
  const tombstone = row.tombstone_at != null;
  const hidden = row.hidden_at != null;
  const deletedForViewer = tombstone || (hidden && !viewerIsAdmin);
  const refPostId = row.ref_post_id == null ? null : String(row.ref_post_id);
  // Only a repost carries a quote preview. An edit marker also has a
  // ref_post_id (the newer version), but it is a forward pointer, not a quote.
  let repost: RepostOf | null = null;
  if (kind === "repost" && refPostId && row.r_author != null) {
    const rDeleted = row.r_tombstone != null || row.r_hidden != null;
    repost = {
      authorName: String(row.r_author),
      body: rDeleted ? "" : String(row.r_body),
      deleted: rDeleted,
    };
  }
  return {
    id: String(row.id),
    homeId: String(row.home_id),
    threadId: row.thread_id == null ? null : String(row.thread_id),
    authorId: String(row.author_id),
    authorName: String(row.display_name),
    body: deletedForViewer ? "" : String(row.body),
    createdAt: String(row.created_at),
    editedAt: row.edited_at == null ? null : String(row.edited_at),
    kind,
    deleted: deletedForViewer,
    // Admins see a hidden post's body, flagged as moderated.
    hidden: hidden && viewerIsAdmin,
    repostOf: refPostId,
    repost,
    quotedIn: [],
    reactions: [],
  };
}

/**
 * Messages in a channel (a thread, or a home's main channel), oldest first.
 * Deleted ones remain as tombstones. Reactions are attached for `viewerId`.
 */
async function listChannelMessages(
  channel: Channel,
  viewerId: string,
  viewerIsAdmin: boolean,
): Promise<Message[]> {
  const scope = channel.threadId
    ? { clause: "m.thread_id = ?", arg: channel.threadId }
    : { clause: "m.home_id = ? AND m.thread_id IS NULL", arg: channel.homeId };
  const { rows } = await (await db()).execute({
    sql: `${MESSAGE_SELECT} WHERE ${scope.clause} ORDER BY m.created_at, m.id`,
    args: [scope.arg],
  });
  const messages = rows.map((r) => rowToMessage(r, viewerIsAdmin));
  const [reactions, quoted] = await Promise.all([
    reactionsByMessage(channel, viewerId),
    quotedThreadsByMessage(
      messages.map((m) => m.id),
      channel.threadId ?? null,
    ),
  ]);
  for (const m of messages) {
    m.reactions = reactions.get(m.id) ?? [];
    m.quotedIn = quoted.get(m.id) ?? [];
  }
  return messages;
}

/**
 * For each given post, the distinct (active) threads that repost it — the
 * bidirectional "quoted in" link. Excludes the channel being viewed
 * (`excludeThreadId`) so a post doesn't link back to its own thread, and
 * excludes archived threads to keep the affordance about live branches.
 */
async function quotedThreadsByMessage(
  postIds: string[],
  excludeThreadId: string | null,
): Promise<Map<string, QuoteRef[]>> {
  const map = new Map<string, QuoteRef[]>();
  if (postIds.length === 0) return map;
  const placeholders = postIds.map(() => "?").join(",");
  const { rows } = await (await db()).execute({
    sql:
      "SELECT DISTINCT m.ref_post_id AS oid, t.id AS tid, t.title AS title " +
      "FROM messages m JOIN threads t ON t.id = m.thread_id " +
      "WHERE m.kind = 'repost' AND m.thread_id IS NOT NULL " +
      `AND t.archived_at IS NULL AND m.ref_post_id IN (${placeholders}) ` +
      "ORDER BY t.created_at",
    args: postIds,
  });
  for (const row of rows) {
    const tid = String(row.tid);
    if (tid === excludeThreadId) continue;
    const oid = String(row.oid);
    const list = map.get(oid) ?? [];
    list.push({ threadId: tid, title: String(row.title) });
    map.set(oid, list);
  }
  return map;
}

/** Messages in a thread, oldest first. */
export function listMessages(
  threadId: string,
  viewerId = "",
  viewerIsAdmin = false,
): Promise<Message[]> {
  return listChannelMessages({ homeId: "", threadId }, viewerId, viewerIsAdmin);
}

/** Messages in a home's main channel (no thread), oldest first. */
export function listMainMessages(
  homeId: string,
  viewerId = "",
  viewerIsAdmin = false,
): Promise<Message[]> {
  return listChannelMessages(
    { homeId, threadId: null },
    viewerId,
    viewerIsAdmin,
  );
}

/**
 * Repost (pick up) a message into a thread, with an optional comment (`body`).
 * Link flattening: a repost always references the ORIGINAL, so reposting a
 * repost copies its `ref_post_id` rather than pointing at the repost.
 */
export async function repostMessage(
  input: {
    homeId: string;
    /** Omit (or `null`) to repost into the home's main channel. */
    threadId?: string | null;
    authorId: string;
    sourceMessageId: string;
    body?: string;
  },
): Promise<Message> {
  const source = await getMessage(input.sourceMessageId);
  if (!source) throw new HomeError("source message not found", 404);
  if (input.threadId) await assertWritable(input.threadId);
  const original = source.repostOf ?? source.id;

  const id = monotonicUlid();
  const body = (input.body ?? "").trim();
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new HomeError(`message too long (max ${MAX_MESSAGE_LENGTH})`);
  }
  await (await db()).execute({
    sql:
      "INSERT INTO messages (id, home_id, thread_id, author_id, body, kind, ref_post_id) " +
      "VALUES (?, ?, ?, ?, ?, 'repost', ?)",
    args: [
      id,
      input.homeId,
      input.threadId ?? null,
      input.authorId,
      body,
      original,
    ],
  });
  if (input.threadId) await touchThread(input.threadId, input.authorId);
  const message = await getMessage(id);
  if (!message) throw new Error(`repostMessage failed to read back ${id}`);
  return message;
}

/** Minimal message info for authorization (who/where), or `null`. */
export async function getMessageContext(
  messageId: string,
): Promise<
  { threadId: string | null; homeId: string; authorId: string } | null
> {
  const { rows } = await (await db()).execute({
    sql: "SELECT thread_id, home_id, author_id FROM messages WHERE id = ?",
    args: [messageId],
  });
  const row = rows[0];
  if (!row) return null;
  return {
    threadId: row.thread_id == null ? null : String(row.thread_id),
    homeId: String(row.home_id),
    authorId: String(row.author_id),
  };
}

/**
 * Author edit (forward-repost, per the design): the new content is re-posted
 * at the tail and the old position becomes a forward "edit" marker pointing at
 * the new version (its body is discarded). Only the author's latest live post
 * in the channel can be edited. Every existing reference (reposts, prior edit
 * markers) is re-pointed to the new version, keeping everything flattened to
 * the latest. Returns the new post.
 */
export async function editMessage(
  input: { messageId: string; authorId: string; body: string },
): Promise<Message> {
  const body = input.body.trim();
  if (!body) throw new HomeError("message body is required");
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new HomeError(`message too long (max ${MAX_MESSAGE_LENGTH})`);
  }
  const client = await db();
  const { rows } = await client.execute({
    sql: "SELECT home_id, thread_id, author_id, kind, " +
      "tombstone_at, hidden_at FROM messages WHERE id = ?",
    args: [input.messageId],
  });
  const row = rows[0];
  if (
    !row || String(row.author_id) !== input.authorId || row.kind !== "normal" ||
    row.tombstone_at != null || row.hidden_at != null
  ) {
    throw new HomeError("message not found or not editable", 404);
  }
  const homeId = String(row.home_id);
  const threadId = row.thread_id == null ? null : String(row.thread_id);
  if (threadId) await assertWritable(threadId);

  // Only the author's latest live post in the channel may be edited. Order by
  // id (monotonic ULID) rather than created_at, whose second granularity ties.
  const scope = threadId
    ? { clause: "thread_id = ?", arg: threadId }
    : { clause: "home_id = ? AND thread_id IS NULL", arg: homeId };
  const newer = await client.execute({
    sql: `SELECT 1 FROM messages WHERE ${scope.clause} AND author_id = ? ` +
      "AND id > ? AND kind = 'normal' AND tombstone_at IS NULL LIMIT 1",
    args: [scope.arg, input.authorId, input.messageId],
  });
  if (newer.rows.length > 0) {
    throw new HomeError("最新の投稿のみ編集できます");
  }

  const newId = monotonicUlid();
  await client.batch([
    {
      sql: "INSERT INTO messages (id, home_id, thread_id, author_id, body) " +
        "VALUES (?, ?, ?, ?, ?)",
      args: [newId, homeId, threadId, input.authorId, body],
    },
    // Re-point existing references (reposts / prior markers) to the new version.
    {
      sql: "UPDATE messages SET ref_post_id = ? WHERE ref_post_id = ?",
      args: [newId, input.messageId],
    },
    // The old position becomes a forward edit marker; its body is discarded.
    {
      sql:
        "UPDATE messages SET kind = 'edit', ref_post_id = ?, body = '' WHERE id = ?",
      args: [newId, input.messageId],
    },
  ], "write");

  if (threadId) await touchThread(threadId, input.authorId);
  const message = await getMessage(newId, true);
  if (!message) throw new Error("editMessage failed to read back");
  return message;
}

/**
 * Author deletion: leave a tombstone and destroy the body. Idempotent.
 * Rejected on archived threads (read-only, like any author write).
 */
export async function tombstoneMessage(
  messageId: string,
  authorId: string,
): Promise<void> {
  const ctx = await getMessageContext(messageId);
  if (ctx?.threadId) await assertWritable(ctx.threadId);
  await (await db()).execute({
    sql: "UPDATE messages SET tombstone_at = datetime('now'), body = '' " +
      "WHERE id = ? AND author_id = ? AND tombstone_at IS NULL",
    args: [messageId, authorId],
  });
}

/**
 * Admin moderation: hide a post from non-admins. The body is retained (admins
 * can still read it). Allowed even on archived threads, per the design.
 */
export async function hideMessage(messageId: string): Promise<void> {
  await (await db()).execute({
    sql: "UPDATE messages SET hidden_at = datetime('now') " +
      "WHERE id = ? AND hidden_at IS NULL",
    args: [messageId],
  });
}
