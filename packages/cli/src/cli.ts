import { connectMain } from "../../../apps/runner/src/connect-cli.js";
import { cacheMain } from "../../../apps/runner/src/cache-cli.js";
import { ConnectorSetupError } from "../../../apps/runner/src/protocol.js";
import packageJson from "../package.json" with { type: "json" };

const USAGE = `Usage: pistead <command> [options]

Commands:
  connect     Connect this Linux or WSL2 Pi host to a Pistead workspace
  serve       Run Pistead on this computer, for yourself, with it as the host
  cache       List or prune this host's repository cache

Options:
  --help      Show this help
  --version   Show the installed version

Run "pistead connect --help" or "pistead serve --help" for their options.
`;

const [command, ...args] = process.argv.slice(2);
// The server is loaded only for `serve`, so connecting a host never loads it.
const serveMain = async (args: string[]) => (await import("../../../apps/server/src/local/cli.js")).serveMain(args);
const run = command === "connect" ? connectMain : command === "cache" ? cacheMain : command === "serve" ? serveMain : undefined;
if (run) {
  run(args).catch((error: unknown) => {
    // Only connector-authored preflight text is printed: SDK/HTTP errors can contain auth/config detail.
    process.stderr.write(error instanceof ConnectorSetupError
      ? `${error.message}\n`
      : command === "serve" ? "Pistead failed. Check --help, the state directory's permissions, the port, local Pi configuration and sandbox prerequisites.\n"
      : "Connector failed. Check --help, private state permissions, pairing, local Pi configuration and sandbox prerequisites.\n");
    process.exitCode = 1;
  });
} else if (command === "--version" || command === "-v") {
  process.stdout.write(`${packageJson.version}\n`);
} else if (command === undefined || command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(USAGE);
} else {
  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 2;
}
