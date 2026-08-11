import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const repositoryRoot = new URL("../../../", import.meta.url)

async function repositoryFile(path: string): Promise<string> {
  return readFile(new URL(path, repositoryRoot), "utf8")
}

function expectInOrder(document: string, markers: ReadonlyArray<string>): void {
  let previous = -1
  for (const marker of markers) {
    const position = document.indexOf(marker)
    expect(position, `Missing release marker: ${marker}`).toBeGreaterThan(previous)
    previous = position
  }
}

describe("production release cutover contract", () => {
  it("publishes and attests the exact main-branch release SHA", async () => {
    const workflow = await repositoryFile(".github/workflows/release-images.yml")

    expect(workflow).toContain("release_sha:")
    expect(workflow).toContain("ref: ${{ inputs.release_sha }}")
    expect(workflow).toContain('[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]')
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"')
    expect(workflow).toContain('git merge-base --is-ancestor "$RELEASE_SHA" origin/main')
    expect(workflow.match(/sha-\$\{\{ inputs\.release_sha \}\}/gu)).toHaveLength(2)
    expect(workflow.match(/actions\/attest-build-provenance@v2/gu)).toHaveLength(2)
    expect(workflow).toContain("AGENT_DIGEST: ${{ steps.agent.outputs.digest }}")
    expect(workflow).toContain("BACKUP_DIGEST: ${{ steps.backup.outputs.digest }}")
    expect(workflow).not.toContain("sha-${{ github.sha }}")
  })

  it("keeps the agent-first cutover gates in their required order", async () => {
    const runbook = await repositoryFile("docs/runbooks/deployment.md")

    expectInOrder(runbook, [
      "### 1. Publish attested images from the release SHA",
      "### 2. Deploy the compatible agent while the old Core stays live",
      "### 3. Verify the new agent against the old Core",
      "### 4. Drain runs and deploy the reviewed Cloudflare plan",
      "### 5. Wait for the External Secrets refresh",
      "### 6. Force and verify an agent restart",
      "### 7. Accept traffic and test domain tools"
    ])

    expect(runbook).toContain("Do not run the Cloudflare deployment in this step.")
    expect(runbook).toContain("packages/contracts/test/agent.test.ts")
    expect(runbook).toContain("pnpm --filter @bob/cloudflare-infra deploy")
    expect(runbook).toContain('force-sync="$ESO_REQUESTED_AT"')
    expect(runbook).toContain("rollout restart deployment/bob-agent")
  })

  it("checks the stable Core routes and the authenticated internal path", async () => {
    const runbook = await repositoryFile("docs/runbooks/deployment.md")

    expect(runbook).toContain('CORE_URL="https://bob.${BOB_DOMAIN}"')
    expect(runbook).toContain('curl -fsS "$CORE_URL/health"')
    expect(runbook).toContain('"$CORE_URL/setup"')
    expect(runbook).toContain("kubectl --context=teampitch-prod -n bob exec deployment/bob-agent")
    expect(runbook).toContain('env EXPECTED_CORE_URL="$CORE_URL"')
    expect(runbook).toContain("process.env.CORE_URL !== process.env.EXPECTED_CORE_URL")
    expect(runbook).toContain("`${process.env.CORE_URL}/internal/tools`")
    expect(runbook).toContain('response.status !== 400 || body.code !== "invalid_request"')
    expect(runbook).toContain("Do not use a `workers.dev` address as `CORE_URL`.")
  })

  it("drains old runs and tool calls before the Core boundary changes", async () => {
    const runbook = await repositoryFile("docs/runbooks/deployment.md")

    expect(runbook).toContain("agent_runs WHERE status IN ('pending','claimed','executing')")
    expect(runbook).toContain("tool_calls WHERE status IN ('pending','claimed','executing')")
    expect(runbook).toContain(".active_runs == 0 and .active_tool_calls == 0")
    expect(runbook).toContain("Stop when either count is not zero.")
  })

  it("defines distinct rollback paths without reversing additive migrations", async () => {
    const runbook = await repositoryFile("docs/runbooks/incident-recovery.md")

    expect(runbook).toContain("## Roll back before the Core deployment")
    expect(runbook).toContain("## Roll back after the Core deployment")
    expect(runbook.match(/\$PRIOR_ARGO_SHA/gu)).toHaveLength(2)
    expect(runbook.match(/\$PRIOR_AGENT_IMAGE/gu)).toHaveLength(2)
    expect(runbook).toContain("Never roll back additive D1 migrations.")
    expect(runbook).toContain("Keep the stable `bob.<domain>` host")
  })
})
