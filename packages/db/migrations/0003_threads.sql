-- 0003_threads — Thread and Message.
--
-- Threads are conversation containers inside a Home; messages belong to a
-- thread. Tombstone/edit columns (edited_at, deleted_at) are included now so
-- later moderation/edit features (design doc: "traces remain, content
-- disappears") don't need a schema change — this slice only writes/reads live
-- messages. Auto-archive after inactivity is a later milestone; archived_at is
-- here for it.

CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,           -- ULID
  home_id     TEXT NOT NULL REFERENCES homes (id),
  title       TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users (id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS threads_home_idx ON threads (home_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,            -- ULID
  thread_id  TEXT NOT NULL REFERENCES threads (id),
  author_id  TEXT NOT NULL REFERENCES users (id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at  TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id);
