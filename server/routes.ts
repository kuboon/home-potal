import { del, get, post, route } from "@remix-run/fetch-router/routes";

export const routes = route({
  home: get("/"),
  welcome: get("/welcome"),
  signin: get("/signin"),
  homes: get("/homes"),
  agents: get("/agents"),
  notifications: get("/notifications"),
  /** Public JWKS so the IdP can verify our RP client assertions. */
  jwks: get("/.well-known/jwks.json"),
  api: route("api", {
    /** DPoP-protected: returns the current session info. */
    me: get("/me"),
    /** DPoP-protected: records the signed-in IdP user into Turso. */
    syncUser: post("/users/sync"),
  }),
  homesApi: route("api/homes", {
    /** GET /api/homes — homes the signed-in user belongs to. */
    list: get("/"),
    /** POST /api/homes — create a home (caller becomes admin). */
    create: post("/"),
    /** GET /api/homes/:homeId/members */
    members: get("/:homeId/members"),
    /** POST /api/homes/:homeId/members — add an existing user (admin only). */
    addMember: post("/:homeId/members"),
    /** POST /api/homes/:homeId/members/:userId/role — change role (admin). */
    setRole: post("/:homeId/members/:userId/role"),
    /** DELETE /api/homes/:homeId/members/:userId — remove member (admin). */
    removeMember: del("/:homeId/members/:userId"),
    /** POST /api/homes/:homeId/invite — issue an invite token (admin). */
    invite: post("/:homeId/invite"),
    /** POST /api/homes/:homeId/theme — set the home's custom CSS (admin). */
    setTheme: post("/:homeId/theme"),
  }),
  agentsApi: route("api/agents", {
    /** GET /api/agents — the caller's agents. */
    list: get("/"),
    /** POST /api/agents — create an agent (returns its token once). */
    create: post("/"),
    /** DELETE /api/agents/:agentId — revoke an agent. */
    delete: del("/:agentId"),
  }),
  invitesApi: route("api/invites", {
    /** POST /api/invites/:token/heartbeat — keep the invite alive (admin). */
    heartbeat: post("/:token/heartbeat"),
    /** DELETE /api/invites/:token — close the invite (admin). */
    close: del("/:token"),
    /** POST /api/invites/:token/accept — join the home (signed-in user). */
    accept: post("/:token/accept"),
  }),
  threadsApi: route("api", {
    /** GET /api/homes/:homeId/threads — threads in a home (members). */
    list: get("/homes/:homeId/threads"),
    /** POST /api/homes/:homeId/threads — create a thread (members). */
    create: post("/homes/:homeId/threads"),
    /** GET /api/threads/:threadId/messages — messages in a thread (members). */
    messages: get("/threads/:threadId/messages"),
    /** POST /api/threads/:threadId/messages — post a message (members). */
    post: post("/threads/:threadId/messages"),
    /** POST /api/threads/:threadId/reposts — repost a message here (members). */
    repost: post("/threads/:threadId/reposts"),
    /** POST /api/messages/:messageId/reactions — toggle a stamp (members). */
    react: post("/messages/:messageId/reactions"),
    /** GET /api/stamps/recent — the caller's recently-used stamps. */
    recentStamps: get("/stamps/recent"),
    /** GET /api/threads/:threadId/stream — SSE change pings (members). */
    stream: get("/threads/:threadId/stream"),
    /** POST /api/messages/:messageId — edit a message (author). */
    editMessage: post("/messages/:messageId"),
    /** DELETE /api/messages/:messageId — delete a message (author or admin). */
    deleteMessage: del("/messages/:messageId"),
  }),
});
