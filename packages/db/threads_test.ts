/**
 * Thread + Message tests against an in-memory libSQL DB (`:memory:`).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { resetClient } from "./client.ts";
import { migrate } from "./migrate.ts";
import { upsertUser } from "./users.ts";
import { createHome } from "./homes.ts";
import {
  archiveStaleThreads,
  createThread,
  deleteMessage,
  editMessage,
  listMessages,
  listThreads,
  postMessage,
  repostMessage,
} from "./threads.ts";
import { db } from "./client.ts";

if (!Deno.env.get("TURSO_DATABASE_URL")) {
  Deno.env.set("TURSO_DATABASE_URL", ":memory:");
}

async function setup() {
  resetClient();
  await migrate();
  await upsertUser({ id: "alice", displayName: "Alice" });
  const home = await createHome({ name: "Family", userId: "alice" });
  return home;
}

Deno.test("threads and messages round-trip", async () => {
  const home = await setup();

  const thread = await createThread({
    homeId: home.id,
    title: "はじめまして",
    userId: "alice",
  });
  assertEquals(thread.title, "はじめまして");
  assertEquals(thread.archivedAt, null);

  const threads = await listThreads(home.id);
  assertEquals(threads.length, 1);

  await postMessage({ threadId: thread.id, authorId: "alice", body: "やあ" });
  await postMessage({ threadId: thread.id, authorId: "alice", body: "元気？" });

  const messages = await listMessages(thread.id);
  assertEquals(messages.length, 2);
  assertEquals(messages[0].body, "やあ");
  assertEquals(messages[0].authorName, "Alice");
});

Deno.test("edit updates body + marks edited; delete leaves a tombstone", async () => {
  const home = await setup();
  const thread = await createThread({
    homeId: home.id,
    title: "t",
    userId: "alice",
  });
  const posted = await postMessage({
    threadId: thread.id,
    authorId: "alice",
    body: "やあ",
  });

  const edited = await editMessage({
    messageId: posted.id,
    authorId: "alice",
    body: "やあ（修正）",
  });
  assertEquals(edited.body, "やあ（修正）");
  assert(edited.editedAt);

  // Non-author cannot edit.
  await upsertUser({ id: "bob", displayName: "Bob" });
  await assertRejects(() =>
    editMessage({ messageId: posted.id, authorId: "bob", body: "x" })
  );

  await deleteMessage(posted.id);
  const after = await listMessages(thread.id);
  assertEquals(after.length, 1); // tombstone remains
  assertEquals(after[0].deleted, true);
  assertEquals(after[0].body, "");
});

Deno.test("repost references the original and flattens repost-of-repost", async () => {
  const home = await setup();
  const t1 = await createThread({
    homeId: home.id,
    title: "src",
    userId: "alice",
  });
  const t2 = await createThread({
    homeId: home.id,
    title: "dst",
    userId: "alice",
  });
  const original = await postMessage({
    threadId: t1.id,
    authorId: "alice",
    body: "元の投稿",
  });

  // Repost into t2 with a comment.
  const repost = await repostMessage({
    threadId: t2.id,
    authorId: "alice",
    sourceMessageId: original.id,
    body: "これ見て",
  });
  assertEquals(repost.repostOf, original.id);
  assert(repost.repost);
  assertEquals(repost.repost.body, "元の投稿");
  assertEquals(repost.body, "これ見て");

  // Repost the repost → flattens to the original, not the repost.
  const repost2 = await repostMessage({
    threadId: t2.id,
    authorId: "alice",
    sourceMessageId: repost.id,
  });
  assertEquals(repost2.repostOf, original.id);

  // When the original is deleted, the repost shows a deleted marker.
  await deleteMessage(original.id);
  const msgs = await listMessages(t2.id);
  const r = msgs.find((m) => m.id === repost.id)!;
  assertEquals(r.repost?.deleted, true);
});

Deno.test("threads with no recent activity auto-archive and become read-only", async () => {
  const home = await setup();
  // A thread created 10 days ago with no messages.
  await (await db()).execute({
    sql: "INSERT INTO threads (id, home_id, title, created_by, created_at) " +
      "VALUES (?, ?, ?, ?, datetime('now', '-10 days'))",
    args: ["old-thread", home.id, "古いスレッド", "alice"],
  });
  // A fresh thread that should stay active.
  const fresh = await createThread({
    homeId: home.id,
    title: "新しい",
    userId: "alice",
  });

  await archiveStaleThreads(home.id);
  const threads = await listThreads(home.id);
  const old = threads.find((t) => t.id === "old-thread")!;
  assert(old.archivedAt);
  assertEquals(threads.find((t) => t.id === fresh.id)!.archivedAt, null);

  // Posting into an archived thread is rejected.
  await assertRejects(() =>
    postMessage({ threadId: "old-thread", authorId: "alice", body: "x" })
  );
});

Deno.test("empty thread title and message body are rejected", async () => {
  const home = await setup();
  await assertRejects(() =>
    createThread({ homeId: home.id, title: "  ", userId: "alice" })
  );

  const thread = await createThread({
    homeId: home.id,
    title: "t",
    userId: "alice",
  });
  await assertRejects(() =>
    postMessage({ threadId: thread.id, authorId: "alice", body: "   " })
  );
});
