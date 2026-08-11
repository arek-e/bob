import { readFile } from "node:fs/promises"

import { assertDeploymentReadiness } from "./deployment-readiness.mjs"

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
  readFile("infra/kubernetes/deployment.yaml", "utf8"),
  readFile("infra/kubernetes/agent-config.yaml", "utf8"),
  readFile("infra/kubernetes/secret-delivery.yaml", "utf8"),
  readFile("infra/kubernetes/network-policy.yaml", "utf8"),
  readFile("infra/kubernetes/cilium-fqdn-policy.yaml", "utf8"),
  readFile("infra/kubernetes/service-account.yaml", "utf8"),
  readFile("infra/openbao/agent-production-policy.hcl", "utf8"),
  readFile("infra/openbao/agent-secret-delivery-production-policy.hcl", "utf8")
])

const result = assertDeploymentReadiness({
  approved: process.env.CILIUM_FQDN_POLICY_APPROVED === "true",
  coreFqdn: process.env.BOB_CORE_FQDN,
  openBaoFqdn: process.env.OPENBAO_FQDN,
  openBaoAddress: process.env.BAO_ADDR,
  agentImageRepository: process.env.BOB_AGENT_IMAGE_REPOSITORY,
  agentImageDigest: process.env.BOB_AGENT_IMAGE_DIGEST,
  tunnelImageRepository: process.env.CLOUDFLARED_IMAGE_REPOSITORY,
  tunnelImageDigest: process.env.CLOUDFLARED_IMAGE_DIGEST,
  deployment,
  config,
  delivery,
  networkPolicy,
  ciliumPolicy,
  serviceAccounts,
  agentPolicy,
  secretDeliveryPolicy
})

process.stdout.write("Deployment readiness checks passed for production.\n")
