// Pins the published connector's whole dependency tree. Pi stopped shipping its own npm-shrinkwrap.json in 1.0.1,
// so without ours `npx pistead` would resolve Pi's transitive dependencies afresh on every install.
//   node scripts/shrinkwrap.mjs          regenerate npm-shrinkwrap.json from package.json (needs the npm registry)
//   node scripts/shrinkwrap.mjs --check  fail when package.json changed without regenerating (run before publishing)
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(packageDir, "package.json");
const shrinkwrapPath = join(packageDir, "npm-shrinkwrap.json");
const read = path => JSON.parse(readFileSync(path, "utf8"));

if (process.argv.includes("--check")) {
  const manifest = read(manifestPath);
  let root;
  try { root = read(shrinkwrapPath).packages?.[""]; } catch { root = undefined; }
  const fields = ["name", "version", "dependencies", "devDependencies"];
  const stale = !root || fields.some(field => !isDeepStrictEqual(root[field], manifest[field]));
  if (stale) {
    console.error("npm-shrinkwrap.json does not match package.json; run `pnpm --filter pistead run shrinkwrap`.");
    process.exit(1);
  }
} else {
  // npm resolves the tree in a scratch copy, so the workspace's pnpm install is untouched.
  const scratch = mkdtempSync(join(tmpdir(), "pistead-shrinkwrap-"));
  try {
    copyFileSync(manifestPath, join(scratch, "package.json"));
    // pnpm passes its own settings as npm_config_* variables; npm should resolve with its defaults and .npmrc only.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
    const npm = (...args) => execFileSync("npm", args, { cwd: scratch, stdio: "inherit", env });
    npm("install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund");
    npm("shrinkwrap");
    copyFileSync(join(scratch, "npm-shrinkwrap.json"), shrinkwrapPath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
