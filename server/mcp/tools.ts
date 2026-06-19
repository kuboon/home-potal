/**
 * MCP tools — web-parity operations an agent can perform, acting as its own
 * `is_agent` user. Each tool reuses the same DB layer, membership checks, and
 * rate limits as the web UI, so an agent has no more power than a human member.
 */

import {
  createThread,
  getMessageContext,
  getRole,
  getThread,
  HomeError,
  listHomesForUser,
  listMessages,
  listThreads,
  postMessage,
  repostMessage,
  toggleReaction,
} from "@scope/db";
import { signalThread } from "../realtime.ts";
import { checkPostLimit, checkRepostLimit } from "../rate_limit.ts";
import { notifyNewMessage } from "../notify.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Json;
  /** Run the tool as `agentId`. Throw {@link ToolError} for caller errors. */
  handler(agentId: string, args: Record<string, unknown>): Promise<Json>;
}

/** A caller-facing tool error (bad input, not a member, rate limited, …). */
export class ToolError extends Error {}

const str = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || !value) {
    throw new ToolError(`${key} (string) is required`);
  }
  return value;
};
const optStr = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? args[key] as string : "";

/** Assert the agent is a member of `homeId`, returning its role. */
async function requireMember(homeId: string, agentId: string): Promise<string> {
  const role = await getRole(homeId, agentId);
  if (!role) throw new ToolError("not a member of this home");
  return role;
}

async function homeIdOfThread(threadId: string): Promise<string> {
  const thread = await getThread(threadId);
  if (!thread) throw new ToolError("thread not found");
  if (thread.archivedAt) throw new ToolError("thread is archived (read-only)");
  return thread.homeId;
}

const wrap = (error: unknown): never => {
  if (error instanceof HomeError) throw new ToolError(error.message);
  throw error;
};

export const tools: McpTool[] = [
  {
    name: "list_homes",
    description: "List the homes (servers) this agent is a member of.",
    inputSchema: { type: "object", properties: {} },
    handler: (agentId) => listHomesForUser(agentId),
  },
  {
    name: "list_threads",
    description: "List threads in a home the agent belongs to.",
    inputSchema: {
      type: "object",
      properties: { homeId: { type: "string" } },
      required: ["homeId"],
    },
    async handler(agentId, args) {
      const homeId = str(args, "homeId");
      await requireMember(homeId, agentId);
      return await listThreads(homeId);
    },
  },
  {
    name: "list_messages",
    description: "List messages in a thread the agent can access.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
    },
    async handler(agentId, args) {
      const threadId = str(args, "threadId");
      const thread = await getThread(threadId);
      if (!thread) throw new ToolError("thread not found");
      await requireMember(thread.homeId, agentId);
      return await listMessages(threadId, agentId);
    },
  },
  {
    name: "create_thread",
    description: "Create a new thread in a home.",
    inputSchema: {
      type: "object",
      properties: { homeId: { type: "string" }, title: { type: "string" } },
      required: ["homeId", "title"],
    },
    async handler(agentId, args) {
      const homeId = str(args, "homeId");
      await requireMember(homeId, agentId);
      try {
        return await createThread({
          homeId,
          title: str(args, "title"),
          userId: agentId,
        });
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "post_message",
    description: "Post a message to a thread.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" }, body: { type: "string" } },
      required: ["threadId", "body"],
    },
    async handler(agentId, args) {
      const threadId = str(args, "threadId");
      const homeId = await homeIdOfThread(threadId);
      await requireMember(homeId, agentId);
      if (!(await checkPostLimit(agentId))) throw new ToolError("rate limited");
      try {
        const message = await postMessage({
          threadId,
          authorId: agentId,
          body: str(args, "body"),
        });
        await signalThread(threadId);
        await notifyNewMessage({
          threadId,
          authorId: agentId,
          body: message.body,
        });
        return message;
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "repost_message",
    description:
      "Repost (quote) a message into a thread, with an optional comment.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        sourceMessageId: { type: "string" },
        body: { type: "string" },
      },
      required: ["threadId", "sourceMessageId"],
    },
    async handler(agentId, args) {
      const threadId = str(args, "threadId");
      const homeId = await homeIdOfThread(threadId);
      await requireMember(homeId, agentId);
      if (!(await checkRepostLimit(agentId))) {
        throw new ToolError("rate limited");
      }
      try {
        const message = await repostMessage({
          threadId,
          authorId: agentId,
          sourceMessageId: str(args, "sourceMessageId"),
          body: optStr(args, "body"),
        });
        await signalThread(threadId);
        await notifyNewMessage({
          threadId,
          authorId: agentId,
          body: message.body,
        });
        return message;
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "react",
    description: "Toggle a stamp (reaction) on a message.",
    inputSchema: {
      type: "object",
      properties: { messageId: { type: "string" }, stamp: { type: "string" } },
      required: ["messageId", "stamp"],
    },
    async handler(agentId, args) {
      const messageId = str(args, "messageId");
      const ctx = await getMessageContext(messageId);
      if (!ctx) throw new ToolError("message not found");
      await requireMember(ctx.homeId, agentId);
      await homeIdOfThread(ctx.threadId); // rejects archived threads
      try {
        return await toggleReaction(messageId, agentId, str(args, "stamp"));
      } catch (error) {
        return wrap(error);
      }
    },
  },
];

export const toolByName = new Map(tools.map((t) => [t.name, t]));
