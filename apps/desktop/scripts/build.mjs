// Bundles the main process, the preload, the local pages, the connector host and the local server into dist;
// electron-builder packages dist/app, and stage-connector.mjs stages dist/host with the connector's production
// dependencies.
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "dist", "app");
const hostOut = join(root, "dist", "host");
rmSync(out, { recursive: true, force: true });
rmSync(hostOut, { recursive: true, force: true });

const node = { bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron"], sourcemap: "linked", logLevel: "info" };
await Promise.all([
  build({ ...node, entryPoints: [join(root, "src/main/index.ts")], outfile: join(out, "main.js") }),
  // Sandboxed preloads can require only a few Electron modules, so everything else is bundled in.
  build({ ...node, entryPoints: [join(root, "src/preload/index.ts")], outfile: join(out, "preload.js") }),
  build({
    // No source maps: the local scheme serves only the pages' own files.
    bundle: true, platform: "browser", format: "iife", target: "chrome140", logLevel: "info",
    entryPoints: { host: join(root, "src/renderer/host.ts"), settings: join(root, "src/renderer/settings.ts") },
    outdir: join(out, "renderer"),
  }),
  // The connector host and the local server (Pistead on this computer), built like the CLI's dist: dependencies stay
  // external, unpackaged resolved from the workspace's node_modules, packaged from the tree stage-connector.mjs installs
  // from the CLI's shrinkwrap. Code splitting keeps the server's optional drivers (Postgres, S3) out of what loads. The
  // .mjs extension makes them ES modules wherever they land.
  build({
    bundle: true, splitting: true, platform: "node", format: "esm", target: "node24", packages: "external", logLevel: "info",
    entryPoints: { "desktop-host": join(root, "../runner/src/desktop-host.ts"), "desktop-server": join(root, "../server/src/local/desktop.ts") },
    outdir: hostOut, chunkNames: "chunks/[name]-[hash]", outExtension: { ".js": ".mjs" },
  }),
]);
mkdirSync(join(out, "renderer"), { recursive: true });
for (const file of ["host.html", "settings.html", "style.css"]) copyFileSync(join(root, "src/renderer", file), join(out, "renderer", file));
// The local server applies the server's migrations from beside its bundle; its web app is the repository's dist/web
// (`pnpm build`), which stage-connector.mjs copies in for packaging.
cpSync(join(root, "../server/migrations"), join(hostOut, "migrations"), { recursive: true });
