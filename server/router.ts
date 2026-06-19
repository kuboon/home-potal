/**
 * home portal (ホムポタ) server — Remix v3 + Deno + DPoP session middleware.
 *
 * Route definitions live in `./routes.ts`; each page/endpoint has a
 * controller under `./controllers/`. This module wires global middleware
 * (static files) and maps routes to controllers. Run with `deno serve`.
 */

import { createRouter } from "@remix-run/fetch-router";
import { staticFiles } from "@remix-run/static-middleware";

import { agentsController } from "./controllers/api/agents.ts";
import { apiController } from "./controllers/api/controller.ts";
import { homesController } from "./controllers/api/homes.ts";
import { invitesController } from "./controllers/api/invites.ts";
import { threadsController } from "./controllers/api/threads.ts";
import { agentsAction } from "./controllers/agents.tsx";
import { homeAction } from "./controllers/home.tsx";
import { homesAction } from "./controllers/homes.tsx";
import { jwksAction } from "./controllers/jwks.ts";
import { mcpAction } from "./controllers/mcp.ts";
import { notificationsAction } from "./controllers/notifications.tsx";
import { signinAction } from "./controllers/signin.tsx";
import { welcomeAction } from "./controllers/welcome.tsx";
import { routes } from "./routes.ts";

const router = createRouter({
  middleware: [
    staticFiles(new URL("./bundled", import.meta.url).pathname),
  ],
});

router.get(routes.home, homeAction);
router.get(routes.welcome, welcomeAction);
router.get(routes.signin, signinAction);
router.get(routes.homes, homesAction);
router.get(routes.agents, agentsAction);
router.get(routes.notifications, notificationsAction);
router.get(routes.jwks, jwksAction);
router.post(routes.mcp, mcpAction);
router.map(routes.api, apiController);
router.map(routes.agentsApi, agentsController);
router.map(routes.homesApi, homesController);
router.map(routes.invitesApi, invitesController);
router.map(routes.threadsApi, threadsController);

export default router;
