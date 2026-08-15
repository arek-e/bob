import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("trusted infrastructure plan", () => {
  it("declares the reviewed credential handoff before Alchemy planning", async () => {
    const workflows = await Promise.all([
      readFile(new URL("../../../.github/workflows/release-gate.yml", import.meta.url), "utf8"),
      readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
    ])

    for (const workflow of workflows) {
      expect(workflow).toContain('RUNTIME_CREDENTIAL_HANDOFF_ENABLED: "true"')
      expect(workflow).toContain("id-token: write")
      expect(workflow).toContain("run: pnpm infra:plan")
      expect(workflow).toContain("BAO_JWT_ROLE")
      expect(workflow).not.toContain("BAO_DEPLOY_TOKEN")
      expect(workflow).not.toContain("BOB_STAGE")
      expect(workflow).not.toContain("staging")
      expect(workflow).not.toContain("secrets.SENDBLUE_ACCOUNT_ID")
      expect(workflow).not.toContain("secrets.SENDBLUE_LINE_ID")
      expect(workflow).toContain("tailscale/github-action@780049a30b6ff5c378a9e7b389d15ece7a204888")
      expect(workflow).toContain("ping: vault.lamb-bicolor.ts.net")
      expect(workflow.indexOf("tailscale/github-action@")).toBeLessThan(
        workflow.indexOf("pnpm secrets:scan:trusted")
      )
    }
    expect(workflows[0]).toContain("environment: production")
    expect(workflows[0]).toContain("BAO_JWT_ROLE_PRODUCTION")
    expect(workflows[0]).toContain("TS_OAUTH_CLIENT_ID_PRODUCTION")
    expect(workflows[0]).toContain("TS_AUDIENCE_PRODUCTION")
    expect(workflows[1]).toContain("environment: production-readonly")
    expect(workflows[1]).toContain("BAO_JWT_ROLE_READONLY")
    expect(workflows[1]).toContain("TS_OAUTH_CLIENT_ID_READONLY")
    expect(workflows[1]).toContain("TS_AUDIENCE_READONLY")
    expect(workflows[1]).toContain("if: github.event_name == 'push'")
    expect(workflows[1]).toContain("vars.BOB_RUNNER_RELEASE_ENABLED == 'true'")
    expect(workflows[1]).not.toContain("workflow_dispatch:")
    expect(workflows[1]).not.toContain("vars.BAO_JWT_ROLE != ''")
  })

  it("exercises the production contract with offline Alchemy fixtures", async () => {
    const smoke = await readFile(new URL("../alchemy.smoke.run.ts", import.meta.url), "utf8")
    const packageManifest = await readFile(new URL("../package.json", import.meta.url), "utf8")

    expect(smoke).not.toContain("BOB_STAGE")
    expect(smoke).toContain("RUNTIME_CREDENTIAL_HANDOFF_ENABLED: true")
    expect(packageManifest).toContain("--stage prod")
  })

  it("installs exact pnpm before setup-node enables its cache", async () => {
    const workflows = await Promise.all([
      readFile(new URL("../../../.github/workflows/release-gate.yml", import.meta.url), "utf8"),
      readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
    ])

    for (const workflow of workflows) {
      const nodeSetups = workflow.match(/uses: actions\/setup-node@v4/gu) ?? []
      const pnpmBeforeNode =
        workflow.match(
          /uses: pnpm\/action-setup@v4\s+with:\s+version: 10\.19\.0\s+- uses: actions\/setup-node@v4/gu
        ) ?? []
      expect(pnpmBeforeNode).toHaveLength(nodeSetups.length)
      expect(workflow).not.toContain("corepack prepare pnpm")
    }
  })

  it("plans the exact reviewed release commit", async () => {
    const [releaseGate, ci] = await Promise.all([
      readFile(new URL("../../../.github/workflows/release-gate.yml", import.meta.url), "utf8"),
      readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
    ])

    expect(releaseGate).toContain("source_sha:")
    expect(releaseGate).toContain("deployment_sha:")
    expect(releaseGate).toContain("BOB_RELEASE_SHA: ${{ inputs.source_sha }}")
    expect(releaseGate).toContain("ref: ${{ inputs.deployment_sha }}")
    expect(releaseGate).toContain("fetch-depth: 0")
    expect(releaseGate).toContain("SOURCE_SHA: ${{ inputs.source_sha }}")
    expect(releaseGate).toContain("DEPLOYMENT_SHA: ${{ inputs.deployment_sha }}")
    expect(releaseGate).toContain('[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]')
    expect(releaseGate).toContain('[[ "$DEPLOYMENT_SHA" =~ ^[0-9a-f]{40}$ ]]')
    expect(releaseGate).toContain('test "$(git rev-parse HEAD)" = "$DEPLOYMENT_SHA"')
    expect(releaseGate).toContain('git merge-base --is-ancestor "$SOURCE_SHA" origin/main')
    expect(releaseGate).toContain('git merge-base --is-ancestor "$DEPLOYMENT_SHA" origin/main')
    expect(releaseGate).toContain('git merge-base --is-ancestor "$SOURCE_SHA" "$DEPLOYMENT_SHA"')
    expect(releaseGate).toContain('git diff --name-only "$SOURCE_SHA" "$DEPLOYMENT_SHA"')
    expect(releaseGate).toContain('test "${#changed_paths[@]}" -eq 1')
    expect(releaseGate).toContain('test "${changed_paths[0]}" = "infra/coolify/release.json"')
    expect(releaseGate).toContain("infra/coolify/release.json")
    expect(releaseGate).toContain("scripts/verify-release-manifest-delta.mjs")
    expect(releaseGate).not.toContain("infra/kubernetes/test/agent-observability.test.ts")
    expect(releaseGate).not.toContain("infra/cloudflare/test/deployment-readiness.test.ts")
    expect(releaseGate).not.toContain("scripts/deployment-readiness.mjs)")
    expect(releaseGate).toContain("packages: read")
    expect(releaseGate).toContain("docker/login-action@v3")
    expect(releaseGate).toContain("--format '{{.Manifest.Digest}}'")
    expect(releaseGate).toContain('"ghcr.io/arek-e/bob-agent:sha-$SOURCE_SHA"')
    expect(releaseGate).toContain('"ghcr.io/arek-e/bob-data-backup:sha-$SOURCE_SHA"')
    expect(releaseGate).toContain('test "$agent_digest" = "$MANIFEST_AGENT_DIGEST"')
    expect(releaseGate).toContain('test "$backup_digest" = "$MANIFEST_BACKUP_DIGEST"')
    for (const legacyVariable of [
      "CILIUM_FQDN_POLICY_APPROVED",
      "BOB_CORE_FQDN",
      "OPENBAO_FQDN",
      "BOB_AGENT_IMAGE_REPOSITORY",
      "BOB_AGENT_IMAGE_DIGEST",
      "CLOUDFLARED_IMAGE_REPOSITORY",
      "CLOUDFLARED_IMAGE_DIGEST"
    ]) {
      expect(releaseGate).not.toContain(legacyVariable)
    }
    expect(ci).toContain("BOB_RELEASE_SHA: ${{ github.sha }}")
  })

  it("documents the Control Plane release and OpenTofu ownership paths", async () => {
    const [deployment, operations] = await Promise.all([
      readFile(new URL("../../../docs/runbooks/deployment.md", import.meta.url), "utf8"),
      readFile(new URL("../../../docs/runbooks/operations.md", import.meta.url), "utf8")
    ])

    expect(deployment).toContain("gh workflow run release-gate.yml --ref main")
    expect(deployment).toContain('-f source_sha="$RELEASE_SHA"')
    expect(deployment).toContain('-f deployment_sha="$DEPLOYMENT_SHA"')
    expect(deployment).toContain("gh workflow run release.yml -R arek-e/bob-control-plane")
    expect(deployment).toContain("The Control Plane selects `DEPLOYMENT_SHA`")
    expect(deployment).toContain("`teampitch-ops` OpenTofu owns")
    expect(deployment).toContain("Do not apply Runtime Alchemy in production")
    expect(operations).toContain("`https://bob-otel.<BOB_DOMAIN>/v1/traces`")
    expect(operations).toContain("The Node agent does not use this Access token")
  })

  it("automates only reviewed main-branch Coolify releases", async () => {
    const [automaticRelease, releaseImages] = await Promise.all([
      readFile(new URL("../../../.github/workflows/auto-release.yml", import.meta.url), "utf8"),
      readFile(new URL("../../../.github/workflows/release-images.yml", import.meta.url), "utf8")
    ])

    expect(automaticRelease).toContain("workflow_run:")
    expect(automaticRelease).toContain("workflows: [CI]")
    expect(automaticRelease).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(automaticRelease).toContain("github.event.workflow_run.event == 'push'")
    expect(automaticRelease).toContain("github.event.workflow_run.head_branch == 'main'")
    expect(automaticRelease).toContain("vars.BOB_RUNNER_RELEASE_ENABLED == 'true'")
    expect(automaticRelease).toContain("git ls-remote origin refs/heads/main")
    expect(automaticRelease).toContain('changed_paths[0]}" == "infra/coolify/release.json"')
    expect(automaticRelease).toContain("uses: ./.github/workflows/release-images.yml")
    expect(automaticRelease).toContain("infra/coolify/release.json.next")
    expect(automaticRelease).toContain("cloudflared_digest")
    expect(automaticRelease).toContain("observer_digest")
    expect(automaticRelease).toContain("contract_digest")
    expect(automaticRelease).toContain('name: "cloudflared"')
    expect(automaticRelease).toContain('name: "observer"')
    expect(automaticRelease).toContain("scripts/verify-release-manifest-delta.mjs")
    expect(automaticRelease).toContain("git push origin HEAD:main")
    expect(automaticRelease).toContain("GH_REPO: ${{ github.repository }}")
    expect(automaticRelease).toContain(
      'gh workflow run release-gate.yml --repo "$GH_REPO" --ref main'
    )
    expect(automaticRelease).toContain('previous_run_id="$(gh run list --repo "$GH_REPO"')
    expect(automaticRelease).toContain(".databaseId > $previous_run_id")
    expect(automaticRelease).toContain('gh run watch "$run_id" --repo "$GH_REPO" --exit-status')
    expect(automaticRelease).toContain("environment: production")
    expect(automaticRelease).toContain("TS_OAUTH_CLIENT_ID_AUTO_RELEASE")
    expect(automaticRelease).toContain("TS_AUDIENCE_AUTO_RELEASE")
    expect(automaticRelease).toContain("BAO_JWT_ROLE_AUTO_RELEASE")
    expect(automaticRelease).toContain("id-token: write")
    expect(automaticRelease).toContain("control-plane/operator-access")
    expect(automaticRelease).toContain("/v1/instances/${BOB_INSTANCE_ID}/releases")
    expect(automaticRelease).not.toContain("COOLIFY_API_TOKEN")
    expect(automaticRelease).not.toContain("BAO_DEPLOY_TOKEN")
    expect(releaseImages).toContain("workflow_call:")
    expect(releaseImages).toContain("agent_digest:")
    expect(releaseImages).toContain("backup_digest:")
  })
})
