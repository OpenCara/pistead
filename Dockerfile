# syntax=docker/dockerfile:1
# Builds the web client and the bundled server, then runs them as a non-root user with /data for
# the SQLite database (override with DATABASE_URL). Session backups are off unless STORAGE_URL names
# a store, such as file:///data/backups in the same volume.

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app

FROM base AS build
# Only the server, web and connector manifests: the native apps' workspaces (apps/mobile, apps/desktop) stay out of
# the image, and pnpm installs just the workspaces present.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile
COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/shared packages/shared
COPY packages/client packages/client
COPY tsconfig.json ./
RUN pnpm build && pnpm build:server

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile --prod
# dist/server/migrations is produced by `pnpm build:server`; the server resolves it next to the bundle.
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
ENV HOST=0.0.0.0 PORT=8787 DATABASE_URL=sqlite:///data/pistead.sqlite
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/server/main.js"]
