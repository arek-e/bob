import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"

import { assertDeploymentReadiness } from "./deployment-readiness.mjs"

function renderKustomization(directory) {
  const result = spawnSync("kubectl", ["kustomize", directory], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  })
  if (result.error !== undefined) {
    throw new Error(`kubectl kustomize failed for ${directory}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`kubectl kustomize failed for ${directory}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

const [
  deployment,
  config,
  delivery,
  networkPolicy,
  ciliumPolicy,
  serviceAccounts,
  argocdNamespace,
  agentPolicy,
  secretDeliveryPolicy,
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
  readFile("infra/kubernetes/base/deployment.yaml", "utf8"),
  readFile("infra/kubernetes/base/agent-config.yaml", "utf8"),
  readFile("infra/kubernetes/base/secret-delivery.yaml", "utf8"),
  readFile("infra/kubernetes/base/network-policy.yaml", "utf8"),
  readFile("infra/kubernetes/base/cilium-egress-policy.yaml", "utf8"),
  readFile("infra/kubernetes/base/service-account.yaml", "utf8"),
  readFile("infra/argocd/namespace.yaml", "utf8"),
  readFile("infra/openbao/agent-production-policy.hcl", "utf8"),
  readFile("infra/openbao/agent-secret-delivery-production-policy.hcl", "utf8"),
  readFile("infra/openbao/argocd-repository-production-policy.hcl", "utf8"),
  readFile("infra/kubernetes/overlays/prod/kustomization.yaml", "utf8"),
  readFile("infra/kubernetes/kustomization.yaml", "utf8"),
  readFile("infra/kubernetes/base/kustomization.yaml", "utf8"),
  readFile("infra/argocd/repository-external-secret.yaml", "utf8"),
  readFile("infra/argocd/repository-service-account.yaml", "utf8"),
  readFile("infra/argocd/repository-secret-store.yaml", "utf8"),
  readFile("infra/argocd/project.yaml", "utf8"),
  readFile("infra/argocd/application.yaml", "utf8"),
  readFile("infra/argocd/kustomization.yaml", "utf8")
])

const renderedKubernetes = renderKustomization("infra/kubernetes")
const renderedArgocd = renderKustomization("infra/argocd")

assertDeploymentReadiness({
  deployment,
  config,
  delivery,
  networkPolicy,
  ciliumPolicy,
  serviceAccounts,
  argocdNamespace,
  agentPolicy,
  secretDeliveryPolicy,
  argocdRepositoryPolicy,
  productionOverlay,
  kubernetesKustomization,
  baseKustomization,
  argocdRepository,
  argocdRepositoryServiceAccount,
  argocdRepositorySecretStore,
  argocdProject,
  argocdApplication,
  argocdKustomization,
  renderedKubernetes,
  renderedArgocd
})

process.stdout.write("Deployment readiness checks passed for the production GitOps path.\n")
