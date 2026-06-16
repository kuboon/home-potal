import { del, get, post, route } from "@remix-run/fetch-router/routes";

export const routes = route({
  home: get("/"),
  welcome: get("/welcome"),
  signin: get("/signin"),
  homes: get("/homes"),
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
    /** GET /api/threads/:threadId/stream — SSE of new messages (members). */
    stream: get("/threads/:threadId/stream"),
  }),
});
