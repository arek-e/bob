import { spawnSync } from "node:child_process"

const paths = [
  "apps/core-worker",
  "apps/connections-gateway",
  "apps/sendblue-ingress",
  "apps/sendblue-egress",
  "apps/agent",
  "apps/ui",
  "tools/sendblue-reconcile",
  "tools/pi-smoke",
  "tools/data-backup",
  "infra/cloudflare"
]

for (const path of paths) {
  const result = spawnSync("pnpm", ["exec", "varlock", "audit", "--path", ".", "."], {
    cwd: path,
    stdio: "inherit"
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
