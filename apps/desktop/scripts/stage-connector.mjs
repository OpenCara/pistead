// Stages the connector host and the local server for packaging into dist/connector, which electron-builder copies to
// Resources/connector: the app's build of both (dist/host, see build.mjs), the web app the local server serves (the
// repository's dist/web, from `pnpm build`), plus their production dependencies, installed exactly as pinned by
// packages/cli/npm-shrinkwrap.json (the same tree `npx pistead` installs). Needs the npm registry.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "..", "..", "packages", "cli");
const out = join(root, "dist", "connector");
const host = join(root, "dist", "host");
const web = join(root, "..", "..", "dist", "web");
for (const entry of ["desktop-host.mjs", "desktop-server.mjs"]) {
  if (!existsSync(join(host, entry))) throw new Error(`dist/host/${entry} is missing; run \`pnpm run build\` first.`);
}
if (!existsSync(join(web, "index.html"))) throw new Error("dist/web is missing: run `pnpm build` at the repository root first.");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist"), { recursive: true });
// npm ci requires package.json to match the shrinkwrap; the host is an .mjs ES module whatever its "type" says.
for (const file of ["package.json", "npm-shrinkwrap.json", "LICENSE"]) copyFileSync(join(cli, file), join(out, file));
cpSync(host, join(out, "dist"), { recursive: true });
cpSync(web, join(out, "dist", "web"), { recursive: true });
// pnpm passes its own settings as npm_config_* variables; npm should install with its defaults and .npmrc only.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
// Lifecycle scripts stay off: the tree is plain JavaScript, and nothing from the registry runs at build time. Windows
// runs npm as npm.cmd, which needs a shell; the arguments are fixed.
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: out, stdio: "inherit", env, shell: process.platform === "win32" });
// The host imports its dependencies; the packages' command-line shims (symlinks) are not needed in the app.
rmSync(join(out, "node_modules", ".bin"), { recursive: true, force: true });
