// Builds the published CLI into dist:
// - dist/cli.js and its chunks (dist/chunks): the connector, and the local server (`pistead serve`), which is loaded only
//   for that command. Dependencies stay external, installed from npm-shrinkwrap.json; code splitting keeps the server's
//   optional drivers (Postgres, S3), which a local server never loads, out of the code every command runs.
// - dist/pistead.js: the launcher that checks the Node.js version before loading the rest.
// - dist/web and dist/migrations: the web app and the database migrations the local server serves and applies.
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const repository = join(root, "..", "..");
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });

await Promise.all([
  build({
    entryPoints: { cli: join(root, "src/cli.ts") }, outdir: out, chunkNames: "chunks/[name]-[hash]",
    bundle: true, splitting: true, platform: "node", format: "esm", target: "node24", packages: "external", logLevel: "warning",
  }),
  build({
    entryPoints: [join(root, "src/pistead.ts")], outfile: join(out, "pistead.js"),
    platform: "node", format: "esm", target: "node16", banner: { js: "#!/usr/bin/env node" }, logLevel: "warning",
  }),
]);

const web = join(repository, "dist", "web");
if (!existsSync(join(web, "index.html"))) throw new Error("dist/web is missing: run `pnpm build` at the repository root first.");
cpSync(web, join(out, "web"), { recursive: true });
cpSync(join(repository, "apps", "server", "migrations"), join(out, "migrations"), { recursive: true });
