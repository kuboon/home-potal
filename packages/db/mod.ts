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
  setHomeTheme,
  setMemberRole,
} from "./homes.ts";
export {
  ARCHIVE_AFTER_DAYS,
  archiveStaleThreads,
  createThread,
  editMessage,
  getMessageContext,
  getThread,
  hideMessage,
  listMainMessages,
  listMessages,
  listThreads,
  listThreadsForViewer,
  MAX_MESSAGE_LENGTH,
  type Message,
  postMessage,
  type QuoteRef,
  repostMessage,
  type RepostOf,
  type Thread,
  type ThreadForViewer,
  tombstoneMessage,
} from "./threads.ts";
export {
  joinedUserIds,
  joinThread,
  joinThreadMany,
  leaveThread,
  type ParticipantState,
} from "./participants.ts";
export {
  type Channel,
  MAX_REACTIONS_PER_MESSAGE,
  reactionsByMessage,
  type ReactionSummary,
  toggleReaction,
} from "./reactions.ts";
export {
  type Agent,
  createAgent,
  deleteAgent,
  getAgentIdByToken,
  listAgentsByOwner,
} from "./agents.ts";
