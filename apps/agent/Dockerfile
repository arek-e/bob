ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @bob/agent build

FROM ${NODE_IMAGE}
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8787
CMD ["pnpm", "--filter", "@bob/agent", "start"]
