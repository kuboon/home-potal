/**
 * Realtime signalling over Deno KV.
 *
 * Turso is the source of truth for messages; Deno KV is used only as a
 * lightweight cross-isolate pub/sub signal. Posting a message bumps a per-
 * thread key; SSE handlers `kv.watch` that key and, on each change, query
 * Turso for messages they haven't sent yet. This fans out across Deno Deploy
 * isolates without a dedicated message bus.
 */

import { kv } from "@kuboon/kv/denoKv.ts";

const threadSignalKey = (threadId: string) => ["thread-signal", threadId];

/** Bump a thread's signal so watchers re-query for new messages. */
export async function signalThread(threadId: string): Promise<void> {
  await kv.set(threadSignalKey(threadId), Date.now());
}

/** A stream that yields once per change to the thread's signal key. */
export function watchThread(
  threadId: string,
): ReadableStream<unknown> {
  return kv.watch([threadSignalKey(threadId)]);
}
