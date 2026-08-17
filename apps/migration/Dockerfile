ARG NODE_IMAGE=node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90
FROM --platform=${BUILDPLATFORM} ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=bob-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --filter @bob/migration... --frozen-lockfile \
  && pnpm --filter @bob/migration build

FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/migration/dist /app/dist
USER node
CMD ["node", "dist/index.js"]
