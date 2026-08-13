# Bob Runtime

Bob Runtime is the open-source application and self-hosting contract for a
private continuity assistant. Product data remains private at runtime.

It uses iMessage through Sendblue. It stores application data in Cloudflare D1.

Managed production operations live in the private Bob Control Plane repository.
Local checks use explicit fixtures and create no cloud environment.

The root `private` package flag prevents npm publication. It does not set the
source repository visibility.

The private `/settings` page manages owner locality and connection status.

The owner can also change locality through Bob's Sendblue conversation.

See [CONTEXT.md](CONTEXT.md) for domain rules. See [PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the build plan.
See [coolify-deployment.md](docs/runbooks/coolify-deployment.md) for the public deployment contract.

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
