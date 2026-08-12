ARG NODE_IMAGE=node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90
FROM --platform=${BUILDPLATFORM} ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=bob-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --filter @bob/agent... --frozen-lockfile \
  && pnpm --filter @bob/agent build \
  && mkdir -p /runtime/apps/agent/dist /runtime/apps/agent/src /runtime/.varlock /runtime/node_modules \
  && cp apps/agent/dist/index.cjs /runtime/apps/agent/dist/index.cjs \
  && cp apps/agent/.env.schema /runtime/apps/agent/.env.schema \
  && cp apps/agent/src/environment.generated.ts /runtime/apps/agent/src/environment.generated.ts \
  && cp .env.schema /runtime/.env.schema \
  && cp .varlock/config.json /runtime/.varlock/config.json \
  && cp -aL apps/agent/node_modules/varlock /runtime/node_modules/varlock

FROM ${NODE_IMAGE}
WORKDIR /app/apps/agent
COPY --from=build --chown=node:node /runtime /app
USER node
EXPOSE 8787
CMD ["node", "../../node_modules/varlock/bin/cli.js", "run", "--inject", "vars", "--skip-cache", "--", "node", "dist/index.cjs"]
