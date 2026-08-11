import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { assertDeploymentReadiness } from "../../../scripts/deployment-readiness.mjs"

const repositoryRoot = new URL("../../../", import.meta.url)

async function validInput() {
  const [
    deployment,
    config,
    delivery,
    networkPolicy,
    ciliumPolicy,
    serviceAccounts,
    agentPolicy,
    secretDeliveryPolicy
  ] = await Promise.all([
    readFile(new URL("infra/kubernetes/deployment.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/agent-config.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/secret-delivery.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/network-policy.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/cilium-fqdn-policy.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/service-account.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/openbao/agent-production-policy.hcl", repositoryRoot), "utf8"),
    readFile(
      new URL("infra/openbao/agent-secret-delivery-production-policy.hcl", repositoryRoot),
      "utf8"
    )
  ])
  return {
    approved: true,
    coreFqdn: "bob.example.com",
    openBaoFqdn: "vault.example.com",
    openBaoAddress: "https://vault.example.com",
    agentImageRepository: "registry.example.com/bob-agent",
    agentImageDigest: `sha256:${"a".repeat(64)}`,
    tunnelImageRepository: "docker.io/cloudflare/cloudflared",
    tunnelImageDigest: `sha256:${"b".repeat(64)}`,
    deployment,
    config,
    delivery,
    serviceAccounts,
    agentPolicy,
    secretDeliveryPolicy,
    networkPolicy,
    ciliumPolicy
  } as const
}

describe("Kubernetes deployment readiness", () => {
  it("accepts a fully rendered, digest-pinned, reviewed contract", async () => {
    expect(assertDeploymentReadiness(await validInput())).toEqual({
      agentImage: `registry.example.com/bob-agent@sha256:${"a".repeat(64)}`,
      tunnelImage: `docker.io/cloudflare/cloudflared@sha256:${"b".repeat(64)}`
    })
  })

  it("rejects local images and disabled pulls", async () => {
    const input = await validInput()
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        deployment: input.deployment.replace(
          "${BOB_AGENT_IMAGE_REPOSITORY}@${BOB_AGENT_IMAGE_DIGEST}",
          "bob-agent:local-only"
        )
      })
    ).toThrow(/local-only/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        deployment: input.deployment.replace("IfNotPresent", "Never")
      })
    ).toThrow(/Never/u)
  })

  it("rejects non-digest images and missing bootstrap contracts", async () => {
    const input = await validInput()
    expect(() => assertDeploymentReadiness({ ...input, agentImageDigest: "latest" })).toThrow(
      /digest/u
    )
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        deployment: input.deployment.replace("audience: openbao", "audience: default")
      })
    ).toThrow(/projected OpenBao token/u)
    expect(() => assertDeploymentReadiness({ ...input, delivery: "" })).toThrow(/secret delivery/u)
  })

  it("rejects incomplete Access bootstrap secret delivery", async () => {
    const input = await validInput()

    expect(() =>
      assertDeploymentReadiness({
        ...input,
        delivery: input.delivery.replace("property: CORE_ACCESS_CLIENT_SECRET", "property: OMITTED")
      })
    ).toThrow(/Access runtime secret delivery/u)
  })

  it("rejects an incomplete private registry pull contract", async () => {
    const input = await validInput()

    expect(() =>
      assertDeploymentReadiness({
        ...input,
        deployment: input.deployment.replace("name: bob-ghcr-pull", "name: omitted-pull-secret")
      })
    ).toThrow(/registry pull/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        delivery: input.delivery.replace("property: TOKEN", "property: OMITTED")
      })
    ).toThrow(/secret delivery/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        secretDeliveryPolicy: input.secretDeliveryPolicy.replace(
          'path "ops/data/apps/prod/bob/registry/ghcr"',
          'path "ops/data/apps/prod/bob/registry/omitted"'
        )
      })
    ).toThrow(/secret-delivery OpenBao policy/u)
  })

  it("rejects a secret-delivery identity without an exact scoped policy", async () => {
    const input = await validInput()

    expect(() =>
      assertDeploymentReadiness({
        ...input,
        secretDeliveryPolicy: input.secretDeliveryPolicy.replace(
          'path "ops/data/apps/prod/bob/access/agent-to-core"',
          'path "ops/data/apps/prod/bob/access/omitted"'
        )
      })
    ).toThrow(/secret-delivery OpenBao policy/u)
  })

  it("rejects a missing secret-delivery ServiceAccount", async () => {
    const input = await validInput()

    expect(() => assertDeploymentReadiness({ ...input, serviceAccounts: "" })).toThrow(
      /secret-delivery ServiceAccount/u
    )
  })

  it("checks only the fixed production manifest set", async () => {
    const verifier = await readFile(
      new URL("scripts/verify-deployment-readiness.mjs", repositoryRoot),
      "utf8"
    )
    expect(verifier).not.toContain("BOB_STAGE")
    expect(verifier).not.toContain("overlays/")

    const result = spawnSync(process.execPath, ["scripts/verify-deployment-readiness.mjs"], {
      cwd: fileURLToPath(repositoryRoot),
      env: {
        ...process.env,
        CILIUM_FQDN_POLICY_APPROVED: "true",
        BOB_CORE_FQDN: "bob.example.com",
        OPENBAO_FQDN: "vault.example.com",
        BAO_ADDR: "https://vault.example.com",
        BOB_AGENT_IMAGE_REPOSITORY: "registry.example.com/bob-agent",
        BOB_AGENT_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
        CLOUDFLARED_IMAGE_REPOSITORY: "docker.io/cloudflare/cloudflared",
        CLOUDFLARED_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`
      },
      encoding: "utf8"
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("production")
  })
})
