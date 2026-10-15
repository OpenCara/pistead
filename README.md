# Pistead

Run Pi agents on your own machines and work on them together with your team. Pistead is a self-hosted control plane: a browser UI, a Node.js server, and the `pistead` connector that each host runs to offer its local Pi to a workspace.

## Run it with Docker

```sh
cp apps/server/.env.example .env
# Set APP_ORIGIN (the public https:// origin), SESSION_SECRET and VAULT_KEY in .env, then:
docker compose up -d
```

The server listens on port 8787 and keeps its SQLite database and session backups in the `pistead-data` volume. Put a reverse proxy with TLS in front of it (Caddy, nginx, Traefik, a cloud load balancer); the app serves plain HTTP. If the proxy sets `X-Forwarded-Proto`/`X-Forwarded-Host`, set `TRUST_PROXY=true`. The proxy must pass WebSocket upgrades on `/api/connectors/socket`.

GitHub sign-in needs a GitHub OAuth app whose callback URL is `<APP_ORIGIN>/api/auth/github/callback`; put its id and secret in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

### Providers

Every provider is chosen by a URL in `.env` (all variables are documented in [`apps/server/.env.example`](apps/server/.env.example)):

| Setting | Default | Alternatives |
|---|---|---|
| `DATABASE_URL` | `sqlite:///data/pistead.sqlite` | `postgres://user:password@host:5432/db` (`docker compose --profile postgres up -d` starts one) |
| `STORAGE_URL` (session backups) | `file:///data/backups` | `s3://bucket/prefix?endpoint=https://minio.example.com&region=us-east-1` with `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (or the `AWS_*` names) |

Migrations run automatically at start-up on whichever database is configured; `pnpm db:migrate` (or `node dist/server/main.js --migrate-only`) applies them without starting the server. Switching providers later means starting with an empty database: there is no data migration between SQLite and Postgres.

### Workspace databases

With `WORKSPACE_DATABASES=true`, a workspace owner can connect a Postgres database of their own under **Settings → Workspaces → Session database**. Session backups of that workspace are then saved there instead of in `STORAGE_URL`, and downloads and restores read them back from it:

- Pistead creates `pistead_workspaces`, `pistead_sessions` (each saved session's record, with a `record` JSONB column) and `pistead_session_backups` (the exact backup bytes; `convert_from(snapshot, 'UTF8')::jsonb` reads one) when they are missing, in the first schema of the user's `search_path`. Tables created beforehand are used as they are, so the connecting user needs only `SELECT`, `INSERT` and `UPDATE` on them.
- The control plane keeps each backup's SHA-256 and size, so a snapshot changed in that database is refused on download and restore.
- Only the owner connects, replaces or disconnects it; the password is vault-encrypted and write-only. Whoever can read that database can read the sessions saved there, including their owners' personal environment values, so other members confirm the database before each of their backups is saved there. Pointing the connection at another database asks them again; new credentials for the same one don't.
- Connections use TLS that verifies the server certificate (against the public roots, or a CA certificate the owner pastes), or TLS without verification if the owner chooses it. Hosts must resolve to public addresses; `WORKSPACE_DATABASE_PRIVATE_HOSTS=true` also allows private networks, and unencrypted connections to them.
- If the operator turns the feature off, that workspace's backups stop (they never fall back to `STORAGE_URL`) until its owner disconnects the database.

### Exporting data

Session owners can export a session's records (details, people, approvals, pushes, backups and activity) from the session panel, and workspace owners and admins can export a workspace (settings, members, models, agents, repositories, push access, its database connection and activity, with their own sessions in full and the records of the other sessions they can view) from its settings. Exports are JSON without secrets; a session's conversation is in its backups.

Operators can dump straight from the database, with every session of a workspace in full:

```sh
node dist/server/main.js --dump-workspace WORKSPACE_ID > workspace.json
node dist/server/main.js --dump-session SESSION_ID > session.json
docker compose exec -T pistead node dist/server/main.js --dump-workspace WORKSPACE_ID > workspace.json
pnpm -s db:dump --dump-workspace WORKSPACE_ID > workspace.json   # from source
```

Like start-up, a dump applies pending migrations first.

### Connecting a host

In the web app open **Connections**, create a pairing code, then on the host:

```sh
npx pistead@latest connect --server https://pistead.example.com --pairing-id PAIRING_ID
```

See [`packages/cli/README.md`](packages/cli/README.md) for the connector's requirements and options.

## Development

Requires Node 24 and pnpm.

```sh
pnpm install
cp apps/server/.env.example apps/server/.env   # APP_ORIGIN=http://localhost:5173, TEST_AUTH_* for local sign-in
pnpm dev:server                                 # API on :8787 (SQLite in ./data by default: set DATABASE_URL=sqlite:./data/dev.sqlite)
pnpm dev                                        # web UI on :5173, proxying /api to :8787
```

- `pnpm typecheck`, `pnpm test` (set `TEST_DATABASE_URL=postgres://…` to also run the provider suite against Postgres), `pnpm build` (web), `pnpm build:server` (bundled server in `dist/server`).
- `pnpm test:connected` runs the end-to-end suite against a real server and connector (Linux with bubblewrap).

## Layout

- `apps/server`: the control plane (Hono on Node). `src/db` holds the database providers and the SQLite→Postgres dialect translation; `src/storage` the backup storage providers; `src/workspace-databases` the owner-connected session databases; `src/data-export.ts` the session and workspace exports; `src/connector-hub.ts` the WebSocket relay to connected hosts.
- `apps/web`: the React UI.
- `apps/runner`: the connector runtime that runs on each host, published as the `pistead` CLI from `packages/cli`.
- `packages/shared`: types and policy shared by all of the above.
