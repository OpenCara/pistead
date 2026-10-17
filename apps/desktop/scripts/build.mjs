// Bundles the main process, the preload, the local pages and the connector host into dist; electron-builder packages
// dist/app, and stage-connector.mjs stages dist/host with the connector's production dependencies.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
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
  // The connector host, built like the CLI's dist/cli.js. Its dependencies stay external: unpackaged they resolve from
  // the workspace's node_modules, packaged from the tree stage-connector.mjs installs from the CLI's shrinkwrap. The
  // .mjs extension makes it an ES module wherever it lands.
  build({
    bundle: true, platform: "node", format: "esm", target: "node24", packages: "external", logLevel: "info",
    entryPoints: [join(root, "../runner/src/desktop-host.ts")], outfile: join(hostOut, "desktop-host.mjs"),
  }),
]);
mkdirSync(join(out, "renderer"), { recursive: true });
for (const file of ["host.html", "settings.html", "style.css"]) copyFileSync(join(root, "src/renderer", file), join(out, "renderer", file));
