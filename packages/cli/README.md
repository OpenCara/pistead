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

## License

MIT
