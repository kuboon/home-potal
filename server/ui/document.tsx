/**
 * Document — the persistent HTML shell (nav + `<Frame name="content">`).
 *
 * Client-side, `run()` (bundled from client/mod.ts) turns clicks on
 * `<a rmx-target="content">` into frame reloads instead of full document
 * navigations.
 */

import { Frame, type Handle } from "@remix-run/ui";
import { routes } from "../routes.ts";

type DocumentProps = {
  initialSrc: string;
};

const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "cupcake", label: "Cupcake" },
  { value: "synthwave", label: "Synthwave" },
  { value: "retro", label: "Retro" },
  { value: "dracula", label: "Dracula" },
  { value: "business", label: "Business" },
  { value: "nord", label: "Nord" },
  { value: "lofi", label: "Lo-Fi" },
] as const;

export function Document(handle: Handle<DocumentProps>) {
  return () => (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>home portal (ホムポタ)</title>
        <link rel="icon" href="data:image/png;base64,iVBORw0KGgo=" />
        <script async type="module" src="/mod.js"></script>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body class="min-h-screen bg-base-100 text-base-content">
        <header class="navbar bg-base-200 shadow-sm">
          <div class="navbar-start">
            <a
              class="btn btn-ghost text-xl"
              href={routes.home.href()}
              rmx-target="content"
            >
              ホムポタ
            </a>
          </div>
          <nav class="navbar-end gap-2">
            <ul class="menu menu-horizontal px-1">
              <li>
                <a href={routes.welcome.href()} rmx-target="content">Home</a>
              </li>
              <li>
                <a href={routes.homes.href()} rmx-target="content">Homes</a>
              </li>
              <li>
                <a href={routes.agents.href()} rmx-target="content">
                  エージェント
                </a>
              </li>
              <li>
                <a href={routes.notifications.href()} rmx-target="content">
                  通知
                </a>
              </li>
              <li>
                <a href={routes.signin.href()} rmx-target="content">Sign In</a>
              </li>
            </ul>
            <div class="dropdown dropdown-end">
              <div
                tabindex={0}
                role="button"
                class="btn btn-ghost btn-sm"
                aria-label="Theme"
              >
                Theme
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  class="inline-block opacity-60"
                >
                  <path d="M5 7l5 5 5-5H5z" />
                </svg>
              </div>
              <ul
                tabindex={-1}
                class="dropdown-content bg-base-300 rounded-box z-10 w-52 p-2 shadow-2xl"
              >
                {THEMES.map(({ value, label }) => (
                  <li>
                    <input
                      type="radio"
                      name="theme-dropdown"
                      class="theme-controller w-full btn btn-sm btn-block btn-ghost justify-start"
                      aria-label={label}
                      value={value}
                    />
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        </header>
        <Frame
          name="content"
          src={handle.props.initialSrc}
          fallback={
            <main class="mx-auto w-full max-w-3xl p-8">
              <p>Loading…</p>
            </main>
          }
        />
      </body>
    </html>
  );
}
