// Expo's default Metro config, plus one resolution rule: the shared TypeScript sources (packages/shared) import each
// other as "./types.js", the ESM spelling that tsc, Vite and esbuild map to types.ts. Metro takes the specifier
// literally, so a relative import ending in .js that doesn't resolve as written is retried without the extension,
// which finds the .ts/.tsx source through Metro's usual sourceExts.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (error) {
    if (!/^\.\.?\//.test(moduleName) || !moduleName.endsWith(".js")) throw error;
    try {
      return context.resolveRequest(context, moduleName.slice(0, -".js".length), platform);
    } catch {
      throw error;
    }
  }
};

module.exports = config;
