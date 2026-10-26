import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultStateDir } from "./connect-setup.js";
import { ConnectorSetupError } from "./protocol.js";
import { RepositoryCache } from "./repo-cache.js";

const HELP = `Usage: pistead cache <command> [options]

The repository cache of a connector whose host keeps one (Settings > Hosts > the host > Configuration in Pistead):
one Git mirror per repository, which clone sessions borrow objects from.

Commands:
  list                    Show each cached repository, its size, and how many sessions keep objects in it
                          (pins: sessions from before every session cloned; kept, never pruned)
  prune                   Forget clone sessions idle for longer than --older-than, then collect what nothing reaches
                          any more. A clone in a session idle for longer loses the objects it borrowed

Options:
  --state-dir PATH        Connector state (default ~/.local/share/pistead/connector)
  --older-than DAYS       For prune: how long a clone session may be idle (default 30)
  --help                  Show this help

Safe to run while the connector runs: each repository is locked while it is pruned.
`;

export async function cacheMain(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    help: { type: "boolean" }, "state-dir": { type: "string" }, "older-than": { type: "string" },
  } });
  const [command, ...extra] = positionals;
  if (values.help || command === undefined) { process.stdout.write(HELP); return; }
  if (extra.length || !["list", "prune"].includes(command)) throw new ConnectorSetupError(`Unknown cache command: ${[command, ...extra].join(" ")}. Run "pistead cache --help".`);
  const root = join(resolve(values["state-dir"] ?? defaultStateDir()), "repo-cache");
  const cache = new RepositoryCache({ root });
  if (command === "list") {
    if (values["older-than"] !== undefined) throw new ConnectorSetupError("--older-than applies to prune only.");
    const repositories = await cache.list();
    if (!repositories.length) { process.stdout.write(`No cached repositories in ${root}.\n`); return; }
    for (const repository of repositories) {
      process.stdout.write(`${(repository.bytes / 1024 / 1024).toFixed(1).padStart(9)} MiB  ${String(repository.sessions).padStart(4)} sessions  `
        + `${String(repository.pins).padStart(4)} pins  ${relative(root, repository.directory)}\n`);
    }
    return;
  }
  const days = Number(values["older-than"] ?? "30");
  if (!Number.isInteger(days) || days < 0 || days > 36500) throw new ConnectorSetupError("--older-than must be a whole number of days.");
  const result = await cache.prune(days * 24 * 60 * 60 * 1000);
  process.stdout.write(`Pruned ${result.repositories} cached ${result.repositories === 1 ? "repository" : "repositories"}; `
    + `forgot ${result.sessions} clone ${result.sessions === 1 ? "session" : "sessions"} idle for more than ${days} days.\n`);
}
