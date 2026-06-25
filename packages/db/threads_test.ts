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
  editMessage,
  listMainMessages,
  listMessages,
  listThreads,
  postMessage,
  repostMessage,
  tombstoneMessage,
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

  await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    body: "やあ",
  });
  await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    body: "元気？",
  });

  const messages = await listMessages(thread.id);
  assertEquals(messages.length, 2);
  assertEquals(messages[0].body, "やあ");
  assertEquals(messages[0].authorName, "Alice");
});

Deno.test("main channel: posts with no thread are scoped to the home", async () => {
  const home = await setup();
  const other = await createHome({ name: "Other", userId: "alice" });

  await postMessage({ homeId: home.id, authorId: "alice", body: "メイン1" });
  await postMessage({ homeId: home.id, authorId: "alice", body: "メイン2" });
  await postMessage({ homeId: other.id, authorId: "alice", body: "別ホーム" });

  // A thread post must NOT show up in the main channel.
  const thread = await createThread({
    homeId: home.id,
    title: "t",
    userId: "alice",
  });
  await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    body: "スレッド投稿",
  });

  const main = await listMainMessages(home.id, "alice");
  assertEquals(main.map((m) => m.body), ["メイン1", "メイン2"]);
  assertEquals(main[0].threadId, null);
  assertEquals(main[0].homeId, home.id);
  assertEquals((await listMessages(thread.id)).length, 1);
});

Deno.test("edit re-posts at the tail and leaves a forward marker", async () => {
  const home = await setup();
  const thread = await createThread({
    homeId: home.id,
    title: "t",
    userId: "alice",
  });
  const posted = await postMessage({
    homeId: home.id,
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
  assertEquals(edited.kind, "normal");

  const after = await listMessages(thread.id);
  assertEquals(after.length, 2); // forward marker (old position) + new post
  const marker = after.find((m) => m.id === posted.id)!;
  assertEquals(marker.kind, "edit");
  assertEquals(marker.repostOf, edited.id); // points forward to the new version
  assertEquals(marker.body, "");
  assertEquals(marker.deleted, false);
  // The new post is at the tail.
  assertEquals(after[after.length - 1].id, edited.id);

  // The marker is no longer a normal post, so editing it again is rejected.
  await assertRejects(() =>
    editMessage({ messageId: posted.id, authorId: "alice", body: "x" })
  );
});

Deno.test("only the author's latest post is editable; delete leaves a tombstone", async () => {
  const home = await setup();
  const thread = await createThread({
    homeId: home.id,
    title: "t",
    userId: "alice",
  });
  const first = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    body: "1",
  });
  await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    body: "2",
  });
  // `first` is no longer the author's latest → not editable.
  await assertRejects(() =>
    editMessage({ messageId: first.id, authorId: "alice", body: "x" })
  );

  await tombstoneMessage(first.id, "alice");
  const after = await listMessages(thread.id);
  const m = after.find((x) => x.id === first.id)!;
  assertEquals(m.deleted, true);
  assertEquals(m.body, "");
});

Deno.test("editing a post re-points existing reposts to the new version", async () => {
  const home = await setup();
  const t1 = await createThread({
    homeId: home.id,
    title: "a",
    userId: "alice",
  });
  const t2 = await createThread({
    homeId: home.id,
    title: "b",
    userId: "alice",
  });
  const orig = await postMessage({
    homeId: home.id,
    threadId: t1.id,
    authorId: "alice",
    body: "v1",
  });
  const repost = await repostMessage({
    homeId: home.id,
    threadId: t2.id,
    authorId: "alice",
    sourceMessageId: orig.id,
  });
  const edited = await editMessage({
    messageId: orig.id,
    authorId: "alice",
    body: "v2",
  });

  const r = (await listMessages(t2.id)).find((m) => m.id === repost.id)!;
  assertEquals(r.repostOf, edited.id); // flattened forward to the new version
  assertEquals(r.repost?.body, "v2");
});

Deno.test("quotedIn lists the threads that repost a post (bidirectional link)", async () => {
  const home = await setup();
  const branch = await createThread({
    homeId: home.id,
    title: "branch",
    userId: "alice",
  });
  // A main-channel post quoted into a thread.
  const orig = await postMessage({
    homeId: home.id,
    authorId: "alice",
    body: "main post",
  });
  await repostMessage({
    homeId: home.id,
    threadId: branch.id,
    authorId: "alice",
    sourceMessageId: orig.id,
  });

  const main = await listMainMessages(home.id, "alice");
  const o = main.find((m) => m.id === orig.id)!;
  assertEquals(o.quotedIn, [{ threadId: branch.id, title: "branch" }]);

  // The repost itself (inside the thread) is not "quoted in" anything.
  const inThread = await listMessages(branch.id, "alice");
  assertEquals(inThread.every((m) => m.quotedIn.length === 0), true);
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
    homeId: home.id,
    threadId: t1.id,
    authorId: "alice",
    body: "元の投稿",
  });

  // Repost into t2 with a comment.
  const repost = await repostMessage({
    homeId: home.id,
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
    homeId: home.id,
    threadId: t2.id,
    authorId: "alice",
    sourceMessageId: repost.id,
  });
  assertEquals(repost2.repostOf, original.id);

  // When the original is deleted, the repost shows a deleted marker.
  await tombstoneMessage(original.id, "alice");
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
    postMessage({
      homeId: home.id,
      threadId: "old-thread",
      authorId: "alice",
      body: "x",
    })
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
    postMessage({
      homeId: home.id,
      threadId: thread.id,
      authorId: "alice",
      body: "   ",
    })
  );
});
