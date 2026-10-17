// electron-builder afterPack hook: copies the staged connector (dist/connector, see stage-connector.mjs) into the
// app's resources before signing. Resource filters never copy node_modules, which the connector needs in place.
const { cpSync, existsSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  const staged = join(__dirname, "..", "dist", "connector");
  if (!existsSync(join(staged, "node_modules"))) throw new Error("dist/connector is not staged; run scripts/stage-connector.mjs first.");
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : join(context.appOutDir, "resources");
  cpSync(staged, join(resources, "connector"), { recursive: true, verbatimSymlinks: true });
};
