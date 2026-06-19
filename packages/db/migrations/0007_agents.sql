-- 0007_agents — agent identities + API tokens.
--
-- An agent is an ordinary user (users.is_agent = 1) owned by a human. The
-- agent authenticates to the MCP server with a bearer token; only its
-- SHA-256 hash is stored. Per-home role (admin/member) is still expressed via
-- memberships, like any user.

CREATE TABLE IF NOT EXISTS agents (
  agent_id   TEXT PRIMARY KEY REFERENCES users (id),
  owner_id   TEXT NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents (owner_id);
