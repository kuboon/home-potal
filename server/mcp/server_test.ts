import { assert, assertEquals } from "@std/assert";
import { handleRpc } from "./server.ts";

// These exercise the JSON-RPC glue and the ToolError→isError mapping without
// touching Turso (the server member runs with tight perms; live agent
// posting/membership is covered by the db-layer tests). Paths that would hit
// the DB are reached only after the argument checks asserted here.
const call = (method: string, params?: unknown) =>
  handleRpc({ jsonrpc: "2.0", id: 1, method, params }, "agent_x");

Deno.test("initialize advertises the tools capability", async () => {
  const res = await call("initialize");
  assertEquals(res.result.protocolVersion, "2024-11-05");
  assert(res.result.capabilities.tools);
  assertEquals(res.result.serverInfo.name, "home-portal");
});

Deno.test("tools/list includes the core tools", async () => {
  const res = await call("tools/list");
  const names = res.result.tools.map((t: { name: string }) => t.name);
  for (const n of ["list_homes", "list_threads", "post_message", "react"]) {
    assert(names.includes(n), `missing tool ${n}`);
  }
});

Deno.test("tools/call with an unknown tool is a JSON-RPC error", async () => {
  const res = await call("tools/call", { name: "nope", arguments: {} });
  assertEquals(res.error.code, -32602);
});

Deno.test("tools/call surfaces a missing-arg ToolError as isError", async () => {
  const res = await call("tools/call", {
    name: "list_threads",
    arguments: {},
  });
  assertEquals(res.result.isError, true);
  assert(res.result.content[0].text.includes("homeId"));
});

Deno.test("unknown method returns method-not-found", async () => {
  const res = await call("does/not/exist");
  assertEquals(res.error.code, -32601);
});

Deno.test("notifications/initialized has no response", async () => {
  assertEquals(await call("notifications/initialized"), null);
});
