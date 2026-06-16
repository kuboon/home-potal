/**
 * Thread + Message tests against an in-memory libSQL DB (`:memory:`).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { resetClient } from "./client.ts";
import { migrate } from "./migrate.ts";
import { upsertUser } from "./users.ts";
import { createHome } from "./homes.ts";
import {
  createThread,
  listMessages,
  listThreads,
  postMessage,
} from "./threads.ts";

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
