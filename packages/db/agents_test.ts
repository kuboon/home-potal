import { assert, assertEquals } from "@std/assert";
import { resetClient } from "./client.ts";
import { migrate } from "./migrate.ts";
import { getUser, upsertUser } from "./users.ts";
import {
  createAgent,
  deleteAgent,
  getAgentIdByToken,
  listAgentsByOwner,
} from "./agents.ts";

if (!Deno.env.get("TURSO_DATABASE_URL")) {
  Deno.env.set("TURSO_DATABASE_URL", ":memory:");
}

async function setup() {
  resetClient();
  await migrate();
  await upsertUser({ id: "owner", displayName: "Owner" });
}

Deno.test("createAgent makes an is_agent user and a working token", async () => {
  await setup();
  const { agent, token } = await createAgent({
    ownerId: "owner",
    displayName: "Bot",
  });
  assertEquals(agent.displayName, "Bot");
  assert(agent.id.startsWith("agent_"));
  assert(token.startsWith("hpa_"));

  const user = await getUser(agent.id);
  assertEquals(user?.isAgent, true);

  assertEquals(await getAgentIdByToken(token), agent.id);
  assertEquals(await getAgentIdByToken("hpa_wrong"), null);
  assertEquals(await getAgentIdByToken("not-a-token"), null);

  assertEquals((await listAgentsByOwner("owner")).length, 1);
});

Deno.test("deleteAgent revokes the token (owner-scoped)", async () => {
  await setup();
  const { agent, token } = await createAgent({
    ownerId: "owner",
    displayName: "Bot",
  });

  assertEquals(await deleteAgent("someone-else", agent.id), false);
  assertEquals(await getAgentIdByToken(token), agent.id);

  assertEquals(await deleteAgent("owner", agent.id), true);
  assertEquals(await getAgentIdByToken(token), null);
});
