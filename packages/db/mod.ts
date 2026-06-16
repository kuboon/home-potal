/**
 * `@scope/db` — Turso (libSQL) data layer for home portal.
 *
 * Re-exports the client accessor, the migration runner, and table modules.
 *
 * @module
 */

export { db } from "./client.ts";
export { migrate } from "./migrate.ts";
export {
  getUser,
  upsertUser,
  type UpsertUserInput,
  type User,
} from "./users.ts";
export {
  addMember,
  createHome,
  getHome,
  getRole,
  type Home,
  HomeError,
  type HomeWithRole,
  listHomesForUser,
  listMembers,
  MAX_MEMBERS,
  type Member,
  removeMember,
  type Role,
  setMemberRole,
} from "./homes.ts";
export {
  ARCHIVE_AFTER_DAYS,
  archiveStaleThreads,
  createThread,
  deleteMessage,
  editMessage,
  getMessageContext,
  getThread,
  listMessages,
  listThreads,
  MAX_MESSAGE_LENGTH,
  type Message,
  postMessage,
  repostMessage,
  type RepostOf,
  type Thread,
} from "./threads.ts";
