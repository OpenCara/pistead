// Launcher: compiled without bundling and kept free of imports, so it runs on any Node.js release. The connector
// bundle (./cli.js) pulls in node:sqlite and other Node 24 APIs at load time; check the runtime before loading it.
const major = Number(process.versions.node.split(".")[0]);
if (!(major >= 24)) {
  process.stderr.write(`pistead needs Node.js 24 or newer; this is Node.js ${process.versions.node}.\n`
    + "Install Node.js 24 (for example `nvm install 24`, or from https://nodejs.org), then run the command again.\n");
  process.exit(1);
}
await import("./cli.js");
export {};
