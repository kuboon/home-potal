/**
 * Client-side JS/TSX bundling via `Deno.bundle` (unstable).
 *
 * Each entrypoint under `client/` is compiled to a same-named `.js` (with a
 * linked sourcemap) under `server/bundled/`, which the server then serves
 * through `staticFiles`.
 */

const CLIENT_ENTRIES = [
  "mod.ts",
  "signin_card.tsx",
  "homes_panel.tsx",
  "notifications_card.tsx",
  "agents_panel.tsx",
] as const;

export async function buildJs(
  { minify = false, write = true }: { minify?: boolean; write?: boolean } = {},
) {
  const entrypoints = CLIENT_ENTRIES.map((p) =>
    import.meta.resolve(`../client/${p}`)
  );
  return await Deno.bundle({
    entrypoints,
    outputDir: new URL("../server/bundled", import.meta.url).pathname,
    platform: "browser",
    sourcemap: "linked",
    minify,
    write,
  });
}
