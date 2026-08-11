# Bob

Bob is a private continuity assistant for one owner.

It uses iMessage through Sendblue. It stores application data in Cloudflare D1.

Bob has one production deployment. Local checks use explicit fixtures and create no cloud environment.

The private `/settings` page manages owner locality and connection status.

The owner can also change locality through Bob's Sendblue conversation.

See [CONTEXT.md](CONTEXT.md) for domain rules. See [PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the build plan.

## Local checks

Use Node 22.19 or newer and pnpm 10.19.0.

```sh
corepack enable
corepack prepare pnpm@10.19.0 --activate
pnpm install --frozen-lockfile
pnpm check
```

Do not put secrets in local environment files. Use Varlock and OpenBao.

See [deployment.md](docs/runbooks/deployment.md) before any cloud change.
