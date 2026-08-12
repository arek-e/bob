import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { assertDeploymentReadiness } from "../../../scripts/deployment-readiness.mjs"

const repositoryRoot = new URL("../../../", import.meta.url)
const tunnelImage =
  "docker.io/cloudflare/cloudflared@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf"

function renderKustomization(directory: string): string {
  const result = spawnSync("kubectl", ["kustomize", directory], {
    cwd: fileURLToPath(repositoryRoot),
    encoding: "utf8"
  })
  if (result.status !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout
}

async function validInput() {
  const [
    deployment,
    config,
    delivery,
    backupJob,
    backupDelivery,
    backupNetworkPolicy,
    networkPolicy,
    ciliumPolicy,
    serviceAccounts,
    argocdNamespace,
    agentPolicy,
    secretDeliveryPolicy,
    backupSecretDeliveryPolicy,
    argocdRepositoryPolicy,
    productionOverlay,
    kubernetesKustomization,
    baseKustomization,
    argocdRepository,
    argocdRepositoryServiceAccount,
    argocdRepositorySecretStore,
    argocdProject,
    argocdApplication,
    argocdKustomization
  ] = await Promise.all([
    readFile(new URL("infra/kubernetes/base/deployment.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/base/agent-config.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/base/secret-delivery.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/base/backup-job.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/base/backup-secret-delivery.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/base/backup-network-policy.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/base/network-policy.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/base/cilium-egress-policy.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/base/service-account.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/argocd/namespace.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/openbao/agent-production-policy.hcl", repositoryRoot), "utf8"),
    readFile(
      new URL("infra/openbao/agent-secret-delivery-production-policy.hcl", repositoryRoot),
      "utf8"
    ),
    readFile(
      new URL("infra/openbao/backup-secret-delivery-production-policy.hcl", repositoryRoot),
      "utf8"
    ),
    readFile(
      new URL("infra/openbao/argocd-repository-production-policy.hcl", repositoryRoot),
      "utf8"
    ),
    readFile(new URL("infra/kubernetes/overlays/prod/kustomization.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/kustomization.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/kubernetes/base/kustomization.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/argocd/repository-external-secret.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/argocd/repository-service-account.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/argocd/repository-secret-store.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/argocd/project.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/argocd/application.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/argocd/kustomization.yaml", repositoryRoot), "utf8")
  ])
  return {
    deployment,
    config,
    delivery,
    backupJob,
    backupDelivery,
    backupNetworkPolicy,
    serviceAccounts,
    argocdNamespace,
    agentPolicy,
    secretDeliveryPolicy,
    backupSecretDeliveryPolicy,
    argocdRepositoryPolicy,
    networkPolicy,
    ciliumPolicy,
    productionOverlay,
    kubernetesKustomization,
    baseKustomization,
    argocdRepository,
    argocdRepositoryServiceAccount,
    argocdRepositorySecretStore,
    argocdProject,
    argocdApplication,
    argocdKustomization,
    renderedKubernetes: renderKustomization("infra/kubernetes"),
    renderedArgocd: renderKustomization("infra/argocd")
  } as const
}

describe("production GitOps deployment readiness", () => {
  it("accepts the literal production overlay and scoped Argo CD contract", async () => {
    expect(assertDeploymentReadiness(await validInput())).toEqual({
      agentImage: expect.stringMatching(/^ghcr\.io\/arek-e\/bob-agent@sha256:[a-f0-9]{64}$/u),
      backupImage: expect.stringMatching(
        /^ghcr\.io\/arek-e\/bob-data-backup@sha256:[a-f0-9]{64}$/u
      ),
      tunnelImage,
      openBaoAddress: "http://openbao.openbao.svc.cluster.local:8200",
      releaseSha: expect.stringMatching(/^[a-f0-9]{40}$/u),
      targetRevision: "7e89d038ed7c04709724324d79d4c1e23e6a89cf"
    })
  }, 15_000)

  it("derives release pins from the production overlay", async () => {
    const input = await validInput()
    const current = assertDeploymentReadiness(input)
    const nextAgentImage = `ghcr.io/arek-e/bob-agent@sha256:${"d".repeat(64)}`
    const nextBackupImage = `ghcr.io/arek-e/bob-data-backup@sha256:${"e".repeat(64)}`
    const nextReleaseSha = "2222222222222222222222222222222222222222"
    const currentAgentDigest = current.agentImage.split("@")[1]
    const currentBackupDigest = current.backupImage.split("@")[1]
    const nextAgentDigest = nextAgentImage.split("@")[1]
    const nextBackupDigest = nextBackupImage.split("@")[1]
    if (
      currentAgentDigest === undefined ||
      currentBackupDigest === undefined ||
      nextAgentDigest === undefined ||
      nextBackupDigest === undefined
    ) {
      throw new Error("Missing test image digest")
    }
    const productionOverlay = input.productionOverlay
      .replace(currentAgentDigest, nextAgentDigest)
      .replace(currentBackupDigest, nextBackupDigest)
      .replace(current.releaseSha, nextReleaseSha)
    const renderedKubernetes = input.renderedKubernetes
      .replaceAll(current.agentImage, nextAgentImage)
      .replaceAll(current.backupImage, nextBackupImage)
      .replaceAll(current.releaseSha, nextReleaseSha)

    expect(
      assertDeploymentReadiness({ ...input, productionOverlay, renderedKubernetes })
    ).toMatchObject({
      agentImage: nextAgentImage,
      backupImage: nextBackupImage,
      releaseSha: nextReleaseSha
    })
  })

  it("rejects local images and disabled pulls in the generic base", async () => {
    const input = await validInput()
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        deployment: input.deployment.replace("bob-agent.invalid/repository", "bob-agent:local-only")
      })
    ).toThrow(/local-only/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        deployment: input.deployment.replace("IfNotPresent", "Never")
      })
    ).toThrow(/Never/u)
  })

  it("rejects a mutable image or an external OpenBao runtime address", async () => {
    const input = await validInput()
    const { agentImage } = assertDeploymentReadiness(input)
    const agentDigest = agentImage.split("@")[1]
    if (agentDigest === undefined) throw new Error("Missing agent digest")
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        productionOverlay: input.productionOverlay.replace(agentDigest, "latest")
      })
    ).toThrow(/production Kustomize overlay/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        productionOverlay: input.productionOverlay.replace(
          "http://openbao.openbao.svc.cluster.local:8200",
          "https://vault.lamb-bicolor.ts.net"
        )
      })
    ).toThrow(/production Kustomize overlay/u)
  })

  it("rejects an unsafe entrypoint or namespace Pod Security policy", async () => {
    const input = await validInput()
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        kubernetesKustomization: input.kubernetesKustomization.replace("- overlays/prod", "- base")
      })
    ).toThrow(/only the production overlay/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        argocdNamespace: input.argocdNamespace.replace(
          "pod-security.kubernetes.io/enforce: restricted",
          "pod-security.kubernetes.io/enforce: privileged"
        )
      })
    ).toThrow(/restricted Pod Security/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        baseKustomization: `${input.baseKustomization}\n  - namespace.yaml\n`
      })
    ).toThrow(/must not own the Bob Namespace/u)
  })

  it("rejects incomplete runtime and registry secret delivery", async () => {
    const input = await validInput()
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        delivery: input.delivery.replace("property: CORE_ACCESS_CLIENT_SECRET", "property: OMITTED")
      })
    ).toThrow(/Access runtime secret delivery/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        renderedKubernetes: input.renderedKubernetes.replace(
          "name: bob-ghcr-pull",
          "name: omitted-pull"
        )
      })
    ).toThrow(/registry pull/u)
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

  it("rejects an incomplete backup schedule or broad backup policy", async () => {
    const input = await validInput()
    const { backupImage } = assertDeploymentReadiness(input)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        backupJob: input.backupJob.replace('schedule: "15 */4 * * *"', 'schedule: "* * * * *"')
      })
    ).toThrow(/scheduled backup/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        backupSecretDeliveryPolicy: input.backupSecretDeliveryPolicy.replace(
          "apps/prod/bob/backup/runtime",
          "apps/prod/bob/backup/*"
        )
      })
    ).toThrow(/backup secret-delivery/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        renderedKubernetes: input.renderedKubernetes.replace(backupImage, "bob-backup:latest")
      })
    ).toThrow(/reviewed sha256 digest/u)
  })

  it("rejects an unscoped Argo CD repository or project", async () => {
    const input = await validInput()
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        argocdRepository: input.argocdRepository.replace(
          "kind: SecretStore",
          "kind: ClusterSecretStore"
        )
      })
    ).toThrow(/repository credential/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        argocdRepository: input.argocdRepository.replace(
          "key: apps/prod/bob/argocd/repository",
          "key: ops/apps/prod/bob/argocd/repository"
        )
      })
    ).toThrow(/repository credential/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        argocdRepositorySecretStore: input.argocdRepositorySecretStore.replace(
          "role: bob-argocd-repository",
          "role: shared-reader"
        )
      })
    ).toThrow(/repository SecretStore/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        argocdRepositoryPolicy: input.argocdRepositoryPolicy.replace(
          "apps/prod/bob/argocd/repository",
          "apps/prod/bob/argocd/*"
        )
      })
    ).toThrow(/policy is not exact/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        argocdProject: input.argocdProject.replace("kind: Deployment", 'kind: "*"')
      })
    ).toThrow(/AppProject resource scope/u)
  })

  it("rejects an incomplete or unpinned-shape Argo CD Application", async () => {
    const input = await validInput()
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        argocdApplication: input.argocdApplication.replace("selfHeal: true", "selfHeal: false")
      })
    ).toThrow(/automated Bob/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        argocdApplication: input.argocdApplication.replace("PruneLast=true", "PruneLast=false")
      })
    ).toThrow(/automated Bob/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        argocdApplication: input.argocdApplication.replace(
          "targetRevision: 7e89d038ed7c04709724324d79d4c1e23e6a89cf",
          "targetRevision: v1"
        )
      })
    ).toThrow(/target revision/u)
  })

  it("rejects unsafe or incomplete real Kustomize renders", async () => {
    const input = await validInput()
    const { agentImage } = assertDeploymentReadiness(input)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        renderedKubernetes: input.renderedKubernetes.replace(agentImage, "bob-agent:latest")
      })
    ).toThrow(/reviewed sha256 digest/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        renderedKubernetes: `${input.renderedKubernetes}\n${"${UNRESOLVED_VALUE}"}\n`
      })
    ).toThrow(/unresolved or invalid input/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        renderedKubernetes: input.renderedKubernetes.replace(
          "name: bob-agent-restricted-network",
          "name: omitted-network-policy"
        )
      })
    ).toThrow(/missing NetworkPolicy/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        renderedKubernetes: input.renderedKubernetes.replace("toCIDRSet:", "toFQDNs:")
      })
    ).toThrow(/Cilium egress/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        renderedKubernetes: input.renderedKubernetes.replace("- 192.88.99.0/24", "- 192.88.99.0/25")
      })
    ).toThrow(/Cilium egress/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        renderedKubernetes: input.renderedKubernetes.replace("runAsUser: 1000", "runAsUser: 0")
      })
    ).toThrow(/exact non-root identity/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        renderedKubernetes: input.renderedKubernetes.replace("defaultMode: 288", "defaultMode: 256")
      })
    ).toThrow(/projected OpenBao token/u)
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        renderedArgocd: input.renderedArgocd.replace("name: bob-argocd-repository", "name: omitted")
      })
    ).toThrow(/missing ServiceAccount/u)
  })

  it("runs the fixed production verifier without render environment inputs", async () => {
    const verifier = await readFile(
      new URL("scripts/verify-deployment-readiness.mjs", repositoryRoot),
      "utf8"
    )
    expect(verifier).not.toContain("process.env")
    expect(verifier).not.toContain("BOB_STAGE")
    expect(verifier).toContain('["kustomize", directory]')
    expect(verifier).toContain('renderKustomization("infra/kubernetes")')
    expect(verifier).toContain('renderKustomization("infra/argocd")')

    const result = spawnSync(process.execPath, ["scripts/verify-deployment-readiness.mjs"], {
      cwd: fileURLToPath(repositoryRoot),
      env: process.env,
      encoding: "utf8"
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("production GitOps path")
  })
})
