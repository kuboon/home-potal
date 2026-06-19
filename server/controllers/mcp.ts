/**
 * POST /mcp — MCP endpoint for agents (JSON-RPC over HTTP).
 *
 * Authenticated by `Authorization: Bearer <agent token>` (issued at
 * /api/agents); the bearer resolves to the acting agent user. No DPoP here —
 * agents are headless. All tool calls run as that agent with the same
 * membership checks and rate limits as a human.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import { getAgentIdByToken } from "@scope/db";
import { handleRpc, type JsonRpcRequest } from "../mcp/server.ts";
import type { routes } from "../routes.ts";

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

export const mcpAction = {
  async handler(context) {
    const token = bearer(context.request);
    const agentId = token ? await getAgentIdByToken(token) : null;
    if (!agentId) {
      return Response.json({ error: "invalid agent token" }, { status: 401 });
    }

    let body: JsonRpcRequest;
    try {
      body = await context.request.json();
    } catch {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
        { status: 400 },
      );
    }

    const response = await handleRpc(body, agentId);
    if (response === null) return new Response(null, { status: 202 });
    return Response.json(response);
  },
} satisfies BuildAction<"POST", typeof routes.mcp>;
