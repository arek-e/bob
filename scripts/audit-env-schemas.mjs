import { spawnSync } from "node:child_process"

const audits = [
  ["apps/core-worker", ".", "."],
  ["apps/connections-gateway", ".", "."],
  ["apps/sendblue-channel", "ingress", "ingress"],
  ["apps/sendblue-channel", "egress", "egress"],
  ["apps/agent", ".", "."],
  ["apps/ui", ".", "."],
  ["tools/sendblue-reconcile", ".", "."],
  ["tools/pi-smoke", ".", "."],
  ["tools/data-backup", ".", "."],
  ["infra/cloudflare", ".", "."]
]

for (const [workingDirectory, schemaPath, sourcePath] of audits) {
  const result = spawnSync("pnpm", ["exec", "varlock", "audit", "--path", schemaPath, sourcePath], {
    cwd: workingDirectory,
    stdio: "inherit"
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
