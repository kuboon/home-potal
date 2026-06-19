/**
 * /api/agents — DPoP-protected agent management for the signed-in human.
 *
 * An agent is a user (`is_agent = 1`) owned by the caller, authenticating to
 * the MCP server with a bearer token. The token is returned once at creation
 * (only its hash is stored). To let an agent act in a home, add it as a member
 * by its agent id (same as adding any user); its per-home role applies.
 */

import type { Controller } from "@remix-run/fetch-router";

import {
  createAgent,
  deleteAgent,
  HomeError,
  listAgentsByOwner,
} from "@scope/db";
import { dpop, DpopSession } from "../../middleware/dpop.ts";
import type { routes } from "../../routes.ts";

function currentUserId(session: DpopSession): string | null {
  const value = session.get("userId");
  return typeof value === "string" ? value : null;
}

const unauthorized = () =>
  Response.json({ error: "not signed in" }, { status: 401 });

export const agentsController = {
  middleware: [dpop],
  actions: {
    async list(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      return Response.json({ agents: await listAgentsByOwner(userId) });
    },

    async create(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const body = await context.request.json() as { displayName?: string };
      try {
        const { agent, token } = await createAgent({
          ownerId: userId,
          displayName: body.displayName ?? "",
        });
        // `token` is returned only here; only its hash is stored.
        return Response.json({ agent, token }, { status: 201 });
      } catch (error) {
        if (error instanceof HomeError) {
          return Response.json({ error: error.message }, {
            status: error.status,
          });
        }
        throw error;
      }
    },

    async delete(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { agentId } = context.params;
      const ok = await deleteAgent(userId, agentId);
      if (!ok) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ ok: true });
    },
  },
} satisfies Controller<typeof routes.agentsApi>;
