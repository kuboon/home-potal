/**
 * home portal (ホムポタ) server — Remix v3 + Deno + DPoP session middleware.
 *
 * Route definitions live in `./routes.ts`; each page/endpoint has a
 * controller under `./controllers/`. This module wires global middleware
 * (static files) and maps routes to controllers. Run with `deno serve`.
 */

import { createRouter } from "@remix-run/fetch-router";
import { staticFiles } from "@remix-run/static-middleware";

import { apiController } from "./controllers/api/controller.ts";
import { homesController } from "./controllers/api/homes.ts";
import { threadsController } from "./controllers/api/threads.ts";
import { homeAction } from "./controllers/home.tsx";
import { homesAction } from "./controllers/homes.tsx";
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
router.map(routes.api, apiController);
router.map(routes.homesApi, homesController);
router.map(routes.threadsApi, threadsController);

export default router;
