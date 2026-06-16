/**
 * /api — DPoP-protected Thread + Message endpoints.
 *
 * Reading and posting require the caller to be a member of the thread's home.
 * The acting user is the `userId` bound to the DPoP session.
 */

import type { Controller } from "@remix-run/fetch-router";

import {
  createThread,
  deleteMessage,
  editMessage,
  getMessageContext,
  getRole,
  getThread,
  HomeError,
  listMessages,
  listThreads,
  postMessage,
  repostMessage,
} from "@scope/db";
import { dpop, DpopSession } from "../../middleware/dpop.ts";
import { signalThread, watchThread } from "../../realtime.ts";
import type { routes } from "../../routes.ts";

function currentUserId(session: DpopSession): string | null {
  const value = session.get("userId");
  return typeof value === "string" ? value : null;
}

const unauthorized = () =>
  Response.json({ error: "not signed in" }, { status: 401 });
const forbidden = () =>
  Response.json({ error: "not a member" }, { status: 403 });

function handleError(error: unknown): Response {
  if (error instanceof HomeError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

export const threadsController = {
  middleware: [dpop],
  actions: {
    async list(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      return Response.json({ threads: await listThreads(homeId) });
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

    async messages(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const thread = await getThread(threadId);
      if (!thread) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (!(await getRole(thread.homeId, userId))) return forbidden();
      return Response.json({ messages: await listMessages(threadId) });
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
      const body = await context.request.json() as { body?: string };
      try {
        const message = await postMessage({
          threadId,
          authorId: userId,
          body: body.body ?? "",
        });
        await signalThread(threadId);
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
      try {
        const message = await repostMessage({
          threadId,
          authorId: userId,
          sourceMessageId: body.sourceMessageId,
          body: body.body,
        });
        await signalThread(threadId);
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

      // The stream emits a lightweight `sync` ping on every change to the
      // thread (post/edit/delete); the client re-fetches messages. This keeps
      // edits and deletions in sync, not just appends.
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const ping = (event: string) =>
            controller.enqueue(encoder.encode(`event: ${event}\ndata: {}\n\n`));

          ping("ready");

          const reader = watchThread(threadId).getReader();
          const stop = () => {
            reader.cancel().catch(() => {});
            try {
              controller.close();
            } catch { /* already closed */ }
          };
          context.request.signal.addEventListener("abort", stop);

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
        await signalThread(ctx.threadId);
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
      // Author can delete their own; admins can delete (moderate) any.
      if (ctx.authorId !== userId && role !== "admin") {
        return Response.json({ error: "author or admin only" }, {
          status: 403,
        });
      }
      await deleteMessage(messageId);
      await signalThread(ctx.threadId);
      return Response.json({ ok: true });
    },
  },
} satisfies Controller<typeof routes.threadsApi>;
