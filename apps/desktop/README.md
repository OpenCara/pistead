# Pistead for the desktop

An Electron app with two jobs: the **Pistead window** shows your Pistead server (https://pistead.com by default), and
**This Mac** runs the `pistead` connector on this computer, so it hosts Pi agent sessions without a terminal. macOS
builds ship today; the Linux and Windows targets are declared for later.

- The Pistead window loads the configured server with no preload and no Node, in its own persistent session. It
  navigates only within the server and GitHub (for sign-in); other links open in your default browser.
- This Mac and Settings are pages bundled with the app (served by its own `pistead-app:` scheme under a strict CSP).
  Their preload exposes a small typed bridge (`src/shared/bridge.ts`); the main process checks the sender and
  validates every call.
- The connector runs in an Electron utility process (Electron's own Node.js 24): `dist/host/desktop-host.mjs`, which
  `scripts/build.mjs` bundles from `apps/runner/src/desktop-host.ts`. It uses the CLI's private state
  (`~/.local/share/pistead/connector`), so a computer paired with `pistead connect` is adopted as is; only one of the
  two can run at a time, and the app says so when the CLI holds the pairing. Pairing codes travel only over the IPC
  channel: never argv, environment, files or logs.
- macOS has no isolated sandbox, so starting the host asks for consent in a native dialog showing the CLI's own
  `--unsafe-no-sandbox` warning. Linux uses the bubblewrap sandbox when its prerequisites are installed and asks the
  same consent otherwise; native Windows gets the CLI's WSL2 instructions.
- A host left running when Pistead quits starts again the next time it opens, with the consent given at its start;
  stopping the host, or a host failure, ends that. With the host running, closing every window keeps Pistead in the
  menu bar.

## Develop

```sh
pnpm --filter @pistead/desktop dev        # builds the app and its connector host, then opens it
pnpm --filter @pistead/desktop typecheck
```

Development switches, honored only when the app runs unpackaged:

| Variable | Effect |
| --- | --- |
| `PISTEAD_DESKTOP_ALLOW_FAUX=1` | The host offers the deterministic fixture model instead of Pi's (needs a test-mode server) |
| `PISTEAD_DESKTOP_STATE_DIR=/path` | Connector state other than the CLI's, so your real pairing is untouched |
| `PISTEAD_DESKTOP_USER_DATA=/path` | A separate app profile (settings, window bounds, Pistead session) |

`PISTEAD_DESKTOP_SMOKE=/path` works in any build: the app writes `main.png` (Pistead window), `host.png` (This Mac)
and `settings.png` there once each has rendered, then quits. It never starts or resumes the host.

For an end-to-end run against a local test-mode server, start `pnpm dev:native --port 8789 --no-host --pairing`, set
the server to `http://127.0.0.1:8789` in Settings, and pair from This Mac with the printed pairing ID and code.

A GUI app does not inherit your shell's environment: Pi providers configured only through environment variables (for
example `ANTHROPIC_API_KEY` in `~/.zshrc`) are not visible to the host. Sign in through Pi itself (`auth.json`) so
This Mac finds those models.

## Package

```sh
pnpm --filter @pistead/desktop dist
```

This builds the app, stages the connector into `dist/connector` with its production dependencies installed by `npm ci`
from `packages/cli/npm-shrinkwrap.json` (the registry must be reachable), and writes an arm64 DMG and zip to
`dist/release`. The connector is copied to `Pistead.app/Contents/Resources/connector`, outside the asar.

Icons: `build/icon.svg` (the app icon, Pistead's mark on the macOS icon grid) and `build/tray.svg` (the menu bar
glyph) are the sources of `build/icon.png`, `assets/icon.png`, `assets/tray.png` and `assets/trayTemplate{,@2x}.png`;
re-render the PNGs at those sizes after changing them.

## Signing and notarization

Builds are ad-hoc signed (`mac.identity: "-"`), which is enough to run them on the Mac that built them; Gatekeeper
blocks them elsewhere (right-click › Open, or `xattr -dr com.apple.quarantine Pistead.app`). For distribution:

1. Install a **Developer ID Application** certificate in the login keychain (or export it as a .p12 and set
   `CSC_LINK` to its path or base64 and `CSC_KEY_PASSWORD` to its password).
2. In `electron-builder.yml`, replace `identity: "-"` with the certificate's name (e.g.
   `identity: "Your Name (TEAMID)"`, or drop the line so electron-builder picks it up), set `hardenedRuntime: true`
   (it uses `build/entitlements.mac.plist`) and `notarize: true`.
3. Provide notarization credentials in the environment, either an App Store Connect API key (`APPLE_API_KEY` = path to
   the .p8, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or an Apple ID (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`), then run `pnpm --filter @pistead/desktop dist`. electron-builder signs the app and the connector's
   files, submits it to Apple's notary service and staples the ticket.

Check the result with `codesign --verify --deep --strict --verbose=2 dist/release/mac-arm64/Pistead.app` and
`spctl --assess --type execute --verbose dist/release/mac-arm64/Pistead.app`.

## Linux and Windows

The code keeps platform choices explicit (`process.platform` checks in `src/main`): the tray uses a full-color icon
outside macOS, window icons come from `assets/icon.png`, open-at-login is offered only where Electron supports it, and
closing every window quits unless the host is running. `electron-builder.yml` declares AppImage/deb and NSIS targets;
building them needs `electron-builder --linux` / `--win` and, on Windows, a host that only reports the WSL2
instructions until the connector supports it.
