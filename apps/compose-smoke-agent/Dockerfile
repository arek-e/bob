ARG NODE_IMAGE=node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --chown=node:node apps/compose-smoke-agent/server.mjs /app/server.mjs
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
