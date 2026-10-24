// Sets a release's version, taken from its tag, in the packages the Release workflow builds; nothing is committed.
//   node scripts/set-release-version.mjs <version> <target>...
// Targets:
//   cli      packages/cli/package.json and npm-shrinkwrap.json (prepublishOnly checks they agree)
//   desktop  apps/desktop/package.json, which electron-builder reads for the app's version
//   mobile   apps/mobile/app.json: expo.version is the version without its prerelease suffix (CFBundleShortVersionString
//            takes only digits), and ios.buildNumber is IOS_BUILD_NUMBER, which must grow with every upload
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [version, ...targets] = process.argv.slice(2);
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("usage: set-release-version.mjs <version such as 1.2.3 or 1.2.3-beta.1> <cli|desktop|mobile>...");
}
if (targets.length === 0) throw new Error("Name at least one target: cli, desktop or mobile.");

// Only the top-level version field changes; the manifest keeps its own formatting.
function setManifestVersion(path) {
  const manifest = readFileSync(path, "utf8").replace(/^(  "version": )"[^"]*"/m, (_, key) => key + JSON.stringify(version));
  if (JSON.parse(manifest).version !== version) throw new Error(`${path} has no top-level version field`);
  writeFileSync(path, manifest);
}

for (const target of targets) {
  if (target === "cli") {
    const cli = join(root, "packages", "cli");
    setManifestVersion(join(cli, "package.json"));
    const shrinkwrapPath = join(cli, "npm-shrinkwrap.json");
    const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
    shrinkwrap.version = version;
    shrinkwrap.packages[""].version = version;
    writeFileSync(shrinkwrapPath, JSON.stringify(shrinkwrap, null, 2) + "\n");
    console.log(`pistead@${version}`);
  } else if (target === "desktop") {
    setManifestVersion(join(root, "apps", "desktop", "package.json"));
    console.log(`@pistead/desktop ${version}`);
  } else if (target === "mobile") {
    const buildNumber = process.env.IOS_BUILD_NUMBER;
    if (!buildNumber || !/^[0-9]+(\.[0-9]+){0,2}$/.test(buildNumber)) {
      throw new Error("IOS_BUILD_NUMBER must be set to one to three period-separated integers, such as 42 or 42.1.");
    }
    const appJsonPath = join(root, "apps", "mobile", "app.json");
    const appJson = JSON.parse(readFileSync(appJsonPath, "utf8"));
    appJson.expo.version = version.replace(/-.*$/, "");
    appJson.expo.ios.buildNumber = buildNumber;
    writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + "\n");
    console.log(`Pistead for iOS ${appJson.expo.version} (${buildNumber})`);
  } else {
    throw new Error(`Unknown target ${target}: use cli, desktop or mobile.`);
  }
}
