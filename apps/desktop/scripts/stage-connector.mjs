// Stages the connector host for packaging into dist/connector, which electron-builder copies to Resources/connector:
// the app's build of the host (dist/host, see build.mjs) plus the connector's production dependencies, installed
// exactly as pinned by packages/cli/npm-shrinkwrap.json (the same tree `npx pistead` installs). Needs the npm registry.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "..", "..", "packages", "cli");
const out = join(root, "dist", "connector");
const host = join(root, "dist", "host", "desktop-host.mjs");
if (!existsSync(host)) throw new Error("dist/host/desktop-host.mjs is missing; run `pnpm run build` first.");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist"), { recursive: true });
// npm ci requires package.json to match the shrinkwrap; the host is an .mjs ES module whatever its "type" says.
for (const file of ["package.json", "npm-shrinkwrap.json", "LICENSE"]) copyFileSync(join(cli, file), join(out, file));
copyFileSync(host, join(out, "dist", "desktop-host.mjs"));
// pnpm passes its own settings as npm_config_* variables; npm should install with its defaults and .npmrc only.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
// Lifecycle scripts stay off: the tree is plain JavaScript, and nothing from the registry runs at build time. Windows
// runs npm as npm.cmd, which needs a shell; the arguments are fixed.
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: out, stdio: "inherit", env, shell: process.platform === "win32" });
// The host imports its dependencies; the packages' command-line shims (symlinks) are not needed in the app.
rmSync(join(out, "node_modules", ".bin"), { recursive: true, force: true });
