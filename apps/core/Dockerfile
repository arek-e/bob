ARG NODE_IMAGE=node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90
FROM --platform=${BUILDPLATFORM} ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=bob-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --filter @bob/core... --filter @bob/ui... --frozen-lockfile \
  && pnpm --filter @bob/core build \
  && PUBLIC_API_BASE_URL=same-origin BOB_UI_HOST=127.0.0.1 BOB_UI_PORT=4173 pnpm --filter @bob/ui build \
  && mkdir -p /runtime/node_modules/@varlock /runtime/tools /runtime/.varlock \
  && cp .env.schema /runtime/.env.schema \
  && cp tools/.env.schema /runtime/tools/.env.schema \
  && cp .varlock/config.json /runtime/.varlock/config.json \
  && cp -aL apps/core/node_modules/varlock /runtime/node_modules/varlock \
  && cp -aL apps/core/node_modules/@varlock/hashicorp-vault-plugin /runtime/node_modules/@varlock/hashicorp-vault-plugin

FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/core/dist /app/dist
COPY --from=build --chown=node:node /app/apps/ui/dist /app/ui
COPY --from=build --chown=node:node /runtime/.env.schema /app/.env.schema
COPY --from=build --chown=node:node /runtime/.varlock /app/.varlock
COPY --from=build --chown=node:node /runtime/node_modules /app/node_modules
COPY --from=build --chown=node:node /runtime/tools /app/tools
USER node
EXPOSE 8788
CMD ["node", "dist/index.cjs"]
