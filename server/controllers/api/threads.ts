/**
 * /api — DPoP-protected Thread + Message endpoints.
 *
 * Reading and posting require the caller to be a member of the thread's home.
 * The acting user is the `userId` bound to the DPoP session.
 */

import type { Controller } from "@remix-run/fetch-router";

import {
  createThread,
  getRole,
  getThread,
  HomeError,
  listMessages,
  listMessagesAfter,
  listThreads,
  type Message,
  postMessage,
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

    async stream(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const thread = await getThread(threadId);
      if (!thread) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (!(await getRole(thread.homeId, userId))) return forbidden();

      // Only send messages the client hasn't already loaded.
      let afterId = new URL(context.request.url).searchParams.get("after") ??
        "";
      const encoder = new TextEncoder();

      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: string, data: unknown) =>
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          const flush = async () => {
            const fresh: Message[] = await listMessagesAfter(threadId, afterId);
            for (const m of fresh) {
              send("message", m);
              afterId = m.id;
            }
          };

          send("ready", { threadId });
          await flush();

          const reader = watchThread(threadId).getReader();
          const stop = () => {
            reader.cancel().catch(() => {});
            try {
              controller.close();
            } catch { /* already closed */ }
          };
          context.request.signal.addEventListener("abort", stop);

          try {
            while (true) {
              const { done } = await reader.read();
              if (done) break;
              await flush();
            }
          } catch { /* client gone */ }
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
  },
} satisfies Controller<typeof routes.threadsApi>;
