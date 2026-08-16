ARG NODE_IMAGE=node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90
FROM --platform=${BUILDPLATFORM} ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=bob-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --filter @bob/core-runtime... --filter @bob/ui... --frozen-lockfile \
  && pnpm --filter @bob/core-runtime build \
  && PUBLIC_API_BASE_URL=same-origin BOB_UI_HOST=127.0.0.1 BOB_UI_PORT=4173 pnpm --filter @bob/ui build

FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/core-runtime/dist/index.cjs /app/index.cjs
COPY --from=build --chown=node:node /app/apps/ui/dist /app/ui
USER node
EXPOSE 8788
CMD ["node", "index.cjs"]
