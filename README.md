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

- `apps/server`: the control plane (Hono on Node). `src/db` holds the database providers and the SQLite→Postgres dialect translation; `src/storage` the backup storage providers; `src/connector-hub.ts` the WebSocket relay to connected hosts.
- `apps/web`: the React UI.
- `apps/runner`: the connector runtime that runs on each host, published as the `pistead` CLI from `packages/cli`.
- `packages/shared`: types and policy shared by all of the above.
