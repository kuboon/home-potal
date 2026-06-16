-- 0004_repost — Repost (pickup).
--
-- A message may be a repost of another message: `repost_of` points at the
-- ORIGINAL message. Reposts always reference an original, never another repost
-- (link flattening is done in app code: reposting a repost copies its
-- `repost_of`). The message's own `body` carries the optional repost comment.
-- (Logical reference to messages(id); FK left out to keep ALTER simple.)

ALTER TABLE messages ADD COLUMN repost_of TEXT;

CREATE INDEX IF NOT EXISTS messages_repost_idx ON messages (repost_of);
