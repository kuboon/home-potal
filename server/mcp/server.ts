/**
 * Minimal MCP-over-HTTP (JSON-RPC 2.0) handler.
 *
 * Implements the request/response subset an agent client needs: `initialize`,
 * `tools/list`, `tools/call`, `ping`, and the `notifications/initialized`
 * notification. The HTTP controller authenticates the agent by bearer token
 * and passes its `agentId` here; all tool calls act as that agent.
 */

import { toolByName, ToolError, tools } from "./tools.ts";

const PROTOCOL_VERSION = "2024-11-05";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Json;
}

/**
 * Handle one JSON-RPC message as `agentId`. Returns the response object, or
 * `null` for notifications (which take no reply).
 */
export async function handleRpc(
  req: JsonRpcRequest,
  agentId: string,
): Promise<Json | null> {
  const id = req.id ?? null;
  const reply = (result: Json) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "home-portal", version: "0.1.0" },
      });

    case "notifications/initialized":
      return null; // notification: no response

    case "ping":
      return reply({});

    case "tools/list":
      return reply({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = req.params?.name;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = typeof name === "string" ? toolByName.get(name) : undefined;
      if (!tool) return fail(-32602, `unknown tool: ${name}`);
      try {
        const result = await tool.handler(agentId, args);
        return reply({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (error) {
        // Tool execution errors are reported in-band (isError), per MCP.
        if (error instanceof ToolError) {
          return reply({
            content: [{ type: "text", text: error.message }],
            isError: true,
          });
        }
        throw error;
      }
    }

    default:
      return fail(-32601, `method not found: ${req.method}`);
  }
}
