/**
 * /api — DPoP-protected Thread + Message endpoints.
 *
 * Reading and posting require the caller to be a member of the thread's home.
 * The acting user is the `userId` bound to the DPoP session.
 */

import type { Controller } from "@remix-run/fetch-router";

import {
  createThread,
  editMessage,
  getMessageContext,
  getRole,
  getThread,
  hideMessage,
  HomeError,
  leaveThread,
  listMainMessages,
  listMessages,
  listThreadsForViewer,
  postMessage,
  repostMessage,
  toggleReaction,
  tombstoneMessage,
} from "@scope/db";
import { dpop, DpopSession } from "../../middleware/dpop.ts";
import { notifyNewMessage } from "../../notify.ts";
import {
  signalMainChannel,
  signalThread,
  watchMainChannel,
  watchThread,
} from "../../realtime.ts";
import { checkPostLimit, checkRepostLimit } from "../../rate_limit.ts";
import { getRecentEmojis, pushRecentEmoji } from "../../recent_emojis.ts";
import type { routes } from "../../routes.ts";

function currentUserId(session: DpopSession): string | null {
  const value = session.get("userId");
  return typeof value === "string" ? value : null;
}

const unauthorized = () =>
  Response.json({ error: "not signed in" }, { status: 401 });
const forbidden = () =>
  Response.json({ error: "not a member" }, { status: 403 });
const rateLimited = () =>
  Response.json({ error: "送信が速すぎます。少し待ってください。" }, {
    status: 429,
  });

function handleError(error: unknown): Response {
  if (error instanceof HomeError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

/** Bump the right realtime signal for a message's channel (thread or main). */
function signalChannel(ctx: { homeId: string; threadId: string | null }) {
  return ctx.threadId
    ? signalThread(ctx.threadId)
    : signalMainChannel(ctx.homeId);
}

/**
 * Wrap a KV watch stream as an SSE response. Emits a `ready` ping, then a
 * `sync` ping on every change; the client re-fetches the channel's messages.
 */
function sseFromWatch(
  request: Request,
  watch: ReadableStream<unknown>,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const ping = (event: string) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: {}\n\n`));
      ping("ready");

      const reader = watch.getReader();
      const stop = () => {
        reader.cancel().catch(() => {});
        try {
          controller.close();
        } catch { /* already closed */ }
      };
      request.signal.addEventListener("abort", stop);

      (async () => {
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
            ping("sync");
          }
        } catch { /* client gone */ }
      })();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

export const threadsController = {
  middleware: [dpop],
  actions: {
    async list(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      return Response.json({
        threads: await listThreadsForViewer(homeId, userId),
      });
    },

    async leave(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const thread = await getThread(threadId);
      if (!thread) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (!(await getRole(thread.homeId, userId))) return forbidden();
      await leaveThread(threadId, userId);
      return Response.json({ ok: true });
    },

    async create(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      const body = await context.request.json() as { title?: string };
      try {
        const thread = await createThread({
          homeId,
          title: body.title ?? "",
          userId,
        });
        return Response.json({ thread }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async mainMessages(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      const role = await getRole(homeId, userId);
      if (!role) return forbidden();
      return Response.json({
        messages: await listMainMessages(homeId, userId, role === "admin"),
      });
    },

    async mainPost(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      if (!(await checkPostLimit(userId))) return rateLimited();
      const body = await context.request.json() as { body?: string };
      try {
        const message = await postMessage({
          homeId,
          authorId: userId,
          body: body.body ?? "",
        });
        await signalMainChannel(homeId);
        return Response.json({ message }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async mainRepost(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      const body = await context.request.json() as {
        sourceMessageId?: string;
        body?: string;
      };
      if (!body.sourceMessageId) {
        return Response.json({ error: "sourceMessageId is required" }, {
          status: 400,
        });
      }
      const src = await getMessageContext(body.sourceMessageId);
      if (!src) {
        return Response.json({ error: "source not found" }, { status: 404 });
      }
      if (!(await getRole(src.homeId, userId))) {
        return Response.json({ error: "cannot access source" }, {
          status: 403,
        });
      }
      if (!(await checkRepostLimit(userId))) return rateLimited();
      try {
        const message = await repostMessage({
          homeId,
          authorId: userId,
          sourceMessageId: body.sourceMessageId,
          body: body.body,
        });
        await signalMainChannel(homeId);
        return Response.json({ message }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async mainStream(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      return sseFromWatch(context.request, watchMainChannel(homeId));
    },

    async messages(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const thread = await getThread(threadId);
      if (!thread) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const role = await getRole(thread.homeId, userId);
      if (!role) return forbidden();
      return Response.json({
        messages: await listMessages(threadId, userId, role === "admin"),
      });
    },

    async post(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const thread = await getThread(threadId);
      if (!thread) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (!(await getRole(thread.homeId, userId))) return forbidden();
      if (!(await checkPostLimit(userId))) return rateLimited();
      const body = await context.request.json() as { body?: string };
      try {
        const message = await postMessage({
          homeId: thread.homeId,
          threadId,
          authorId: userId,
          body: body.body ?? "",
        });
        await signalThread(threadId);
        await notifyNewMessage({
          threadId,
          authorId: userId,
          body: message.body,
        });
        return Response.json({ message }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async repost(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const thread = await getThread(threadId);
      if (!thread) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (!(await getRole(thread.homeId, userId))) return forbidden();

      const body = await context.request.json() as {
        sourceMessageId?: string;
        body?: string;
      };
      if (!body.sourceMessageId) {
        return Response.json({ error: "sourceMessageId is required" }, {
          status: 400,
        });
      }
      // Must be able to see the source (member of its home).
      const src = await getMessageContext(body.sourceMessageId);
      if (!src) {
        return Response.json({ error: "source not found" }, { status: 404 });
      }
      if (!(await getRole(src.homeId, userId))) {
        return Response.json({ error: "cannot access source" }, {
          status: 403,
        });
      }
      if (!(await checkRepostLimit(userId))) return rateLimited();
      try {
        const message = await repostMessage({
          homeId: thread.homeId,
          threadId,
          authorId: userId,
          sourceMessageId: body.sourceMessageId,
          body: body.body,
        });
        await signalThread(threadId);
        await notifyNewMessage({
          threadId,
          authorId: userId,
          body: message.body,
        });
        return Response.json({ message }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async stream(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const thread = await getThread(threadId);
      if (!thread) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (!(await getRole(thread.homeId, userId))) return forbidden();
      return sseFromWatch(context.request, watchThread(threadId));
    },

    async editMessage(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { messageId } = context.params;
      const ctx = await getMessageContext(messageId);
      if (!ctx) return Response.json({ error: "not found" }, { status: 404 });
      if (ctx.authorId !== userId) {
        return Response.json({ error: "author only" }, { status: 403 });
      }
      const body = await context.request.json() as { body?: string };
      try {
        const message = await editMessage({
          messageId,
          authorId: userId,
          body: body.body ?? "",
        });
        await signalChannel(ctx);
        return Response.json({ message });
      } catch (error) {
        return handleError(error);
      }
    },

    async deleteMessage(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { messageId } = context.params;
      const ctx = await getMessageContext(messageId);
      if (!ctx) return Response.json({ error: "not found" }, { status: 404 });
      const role = await getRole(ctx.homeId, userId);
      if (!role) return forbidden();
      // Author deletion (own post) destroys the body and leaves a tombstone;
      // admin moderation (another's post) hides it but keeps the body.
      if (ctx.authorId === userId) {
        await tombstoneMessage(messageId, userId);
      } else if (role === "admin") {
        await hideMessage(messageId);
      } else {
        return Response.json({ error: "author or admin only" }, {
          status: 403,
        });
      }
      await signalChannel(ctx);
      return Response.json({ ok: true });
    },

    async react(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { messageId } = context.params;
      const ctx = await getMessageContext(messageId);
      if (!ctx) return Response.json({ error: "not found" }, { status: 404 });
      if (!(await getRole(ctx.homeId, userId))) return forbidden();
      // Main-channel messages (no thread) never archive.
      const thread = ctx.threadId ? await getThread(ctx.threadId) : null;
      if (thread?.archivedAt) {
        return Response.json({ error: "スレッドはアーカイブ済みです" }, {
          status: 409,
        });
      }
      const body = await context.request.json() as { emoji?: string };
      if (!body.emoji) {
        return Response.json({ error: "emoji is required" }, { status: 400 });
      }
      try {
        const result = await toggleReaction(messageId, userId, body.emoji);
        if (result.added) await pushRecentEmoji(userId, body.emoji);
        await signalChannel(ctx);
        return Response.json(result);
      } catch (error) {
        return handleError(error);
      }
    },

    async recentEmojis(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      return Response.json({ emojis: await getRecentEmojis(userId) });
    },
  },
} satisfies Controller<typeof routes.threadsApi>;
