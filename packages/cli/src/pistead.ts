import { connectMain } from "../../../apps/runner/src/connect-cli.js";
import packageJson from "../package.json" with { type: "json" };

const USAGE = `Usage: pistead <command> [options]

Commands:
  connect     Connect this Linux or WSL2 Pi host to a Pistead workspace

Options:
  --help      Show this help
  --version   Show the installed version

Run "pistead connect --help" for connector options.
`;

const [command, ...args] = process.argv.slice(2);
if (command === "connect") {
  connectMain(args).catch(() => {
    // SDK/HTTP errors can contain auth/config detail. Never log their raw text.
    process.stderr.write("Connector failed. Check --help, private state permissions, pairing, local Pi configuration and Linux sandbox prerequisites.\n");
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
