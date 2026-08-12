ARG NODE_IMAGE=node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90
FROM --platform=${BUILDPLATFORM} ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=bob-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --filter @bob/data-backup... --frozen-lockfile \
  && pnpm --filter @bob/data-backup build \
  && mkdir -p /runtime/tools/data-backup/dist /runtime/tools/data-backup/src \
    /runtime/apps/core-worker /runtime/.varlock /runtime/node_modules \
  && cp tools/data-backup/dist/index.mjs /runtime/tools/data-backup/dist/index.mjs \
  && cp tools/data-backup/.env.schema /runtime/tools/data-backup/.env.schema \
  && cp tools/data-backup/src/environment.generated.ts \
    /runtime/tools/data-backup/src/environment.generated.ts \
  && cp -a apps/core-worker/migrations /runtime/apps/core-worker/migrations \
  && cp .env.schema /runtime/.env.schema \
  && cp .varlock/config.json /runtime/.varlock/config.json \
  && cp -aL tools/data-backup/node_modules/varlock /runtime/node_modules/varlock

FROM ${NODE_IMAGE}
WORKDIR /app/tools/data-backup
COPY --from=build --chown=node:node /runtime /app
USER node
CMD ["node", "../../node_modules/varlock/bin/cli.js", "run", "--inject", "blob", "--skip-cache", "--", "node", "dist/index.mjs", "backup"]
