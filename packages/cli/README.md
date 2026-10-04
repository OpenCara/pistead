# pistead

Connect your Linux or WSL2 Pi host to a [Pistead](https://pistead.com) workspace. The connector uses outbound WebSocket only; no inbound port or tunnel is needed.

## Requirements

- Linux or WSL2 (native Windows is unsupported)
- Node.js 24 or newer
- Pi configured locally with the providers and models you want to offer
- `bubblewrap`, Python 3, Git and `flock` (util-linux)

## Usage

In Pistead, open **Connections**, choose a workspace and create a pairing code. Then run, on the Pi host:

```sh
npx pistead@latest connect --server https://pistead.com --pairing-id PAIRING_ID
```

Enter the single-use code when prompted; it is never accepted as an argument. Later runs reuse the private saved connector token:

```sh
npx pistead@latest connect
```

Run `npx pistead connect --help` for all options.

Model credentials stay in Pi on your host. Pairing keeps the host private to you; sharing it with a workspace is a separate, explicit action in the web app.

The connector offers the models matched by `enabledModels` in Pi's `settings.json` (the same patterns Pi uses for model cycling, e.g. `"anthropic/*"`, `"*/claude-opus-5-5*"`), or every authenticated Pi model when that list is unset. `--model PROVIDER/MODEL` (repeatable) overrides both.

## macOS and hosts without bubblewrap

The isolated sandbox needs Linux. On macOS, or Linux without bubblewrap, you can opt out of isolation:

```sh
npx pistead@latest connect --unsafe-no-sandbox
```

This needs only Git on your `PATH` (on macOS: `xcode-select --install` or `brew install git`). The connector prints the risks and asks you to type `unsandboxed` before starting:

- Approved shell commands and commits run directly as your user, with access to your files, credentials (`~/.ssh`, cloud and Git config, Pi's auth) and network, and no CPU, memory or disk limits.
- File tools are confined to each session folder by path checks only.
- Anyone you share the Pi with, and anyone granted approve permission on a session that runs on it, can cause approved commands to run on your machine.

Every command needs an exact human approval unless the session's owner turns on **Auto-approve** in the chat box; then that owner's commands and commits run immediately (GitHub comments still need approval). Pistead labels the host **Unsandboxed** to everyone who can see it.

## Chat options

In a session's chat box you can pick any model this host's Pi offers, its reasoning level, and the access mode for each message: **Read only**, **Ask before acting** (the default) or **Auto-approve** (session owner only). Hosts running a connector older than 0.3.0 keep each session's pinned model; restart the connector with `npx pistead@latest connect` to enable the options.

## License

MIT
