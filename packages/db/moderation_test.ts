/**
 * Moderation visibility tests: author tombstone vs admin hide.
 */

import { assertEquals } from "@std/assert";
import { resetClient } from "./client.ts";
import { migrate } from "./migrate.ts";
import { upsertUser } from "./users.ts";
import { createHome } from "./homes.ts";
import {
  createThread,
  hideMessage,
  listMessages,
  postMessage,
  repostMessage,
  tombstoneMessage,
} from "./threads.ts";

if (!Deno.env.get("TURSO_DATABASE_URL")) {
  Deno.env.set("TURSO_DATABASE_URL", ":memory:");
}

async function setup() {
  resetClient();
  await migrate();
  await upsertUser({ id: "alice", displayName: "Alice" });
  await upsertUser({ id: "bob", displayName: "Bob" });
  const home = await createHome({ name: "H", userId: "alice" });
  const thread = await createThread({
    homeId: home.id,
    title: "t",
    userId: "alice",
  });
  return { home, thread };
}

Deno.test("admin hide: body kept for admins, looks deleted to others", async () => {
  const { home, thread } = await setup();
  const msg = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "bob",
    body: "secret",
  });
  await hideMessage(msg.id);

  const asMember = (await listMessages(thread.id, "bob", false))[0];
  assertEquals(asMember.deleted, true);
  assertEquals(asMember.hidden, false);
  assertEquals(asMember.body, "");

  const asAdmin = (await listMessages(thread.id, "alice", true))[0];
  assertEquals(asAdmin.deleted, false);
  assertEquals(asAdmin.hidden, true);
  assertEquals(asAdmin.body, "secret");
});

Deno.test("author tombstone: body destroyed for everyone, incl. admins", async () => {
  const { home, thread } = await setup();
  const msg = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "bob",
    body: "oops",
  });
  await tombstoneMessage(msg.id, "bob");

  for (const admin of [false, true]) {
    const m = (await listMessages(thread.id, "x", admin))[0];
    assertEquals(m.deleted, true);
    assertEquals(m.hidden, false);
    assertEquals(m.body, "");
  }
});

Deno.test("repost preview reads deleted when the original is hidden (even for admins)", async () => {
  const { home, thread } = await setup();
  const original = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "bob",
    body: "orig",
  });
  const repost = await repostMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    sourceMessageId: original.id,
  });
  await hideMessage(original.id);

  const asAdmin = await listMessages(thread.id, "alice", true);
  const r = asAdmin.find((m) => m.id === repost.id)!;
  assertEquals(r.repost?.deleted, true);
  assertEquals(r.repost?.body, "");
});
