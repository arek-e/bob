const FQDN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[0-9]+)?(?:\/[a-z0-9._/-]+)*@sha256:[a-f0-9]{64}$/u

function requiredText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required for deployment readiness`)
  }
  return value
}

function render(source, replacements) {
  let value = source
  for (const [name, replacement] of Object.entries(replacements)) {
    value = value.replaceAll(`\${${name}}`, replacement)
  }
  return value
}

/**
 * Check the complete local Kubernetes deployment contract without applying it.
 * The return value contains no credentials.
 *
 * @param {Record<string, unknown>} input
 */
export function assertDeploymentReadiness(input) {
  if (input.approved !== true) {
    throw new Error("Cilium FQDN policy approval is required before deployment")
  }
  const coreFqdn = requiredText(input.coreFqdn, "BOB_CORE_FQDN")
  const openBaoFqdn = requiredText(input.openBaoFqdn, "OPENBAO_FQDN")
  if (!FQDN_PATTERN.test(coreFqdn)) {
    throw new Error("BOB_CORE_FQDN must contain the reviewed Core host")
  }
  if (!FQDN_PATTERN.test(openBaoFqdn)) {
    throw new Error("OPENBAO_FQDN must contain the reviewed OpenBao host")
  }

  const agentImageRepository = requiredText(
    input.agentImageRepository,
    "BOB_AGENT_IMAGE_REPOSITORY"
  )
  const tunnelImageRepository = requiredText(
    input.tunnelImageRepository,
    "CLOUDFLARED_IMAGE_REPOSITORY"
  )
  const agentImageDigest = requiredText(input.agentImageDigest, "BOB_AGENT_IMAGE_DIGEST")
  const tunnelImageDigest = requiredText(input.tunnelImageDigest, "CLOUDFLARED_IMAGE_DIGEST")
  if (!DIGEST_PATTERN.test(agentImageDigest) || !DIGEST_PATTERN.test(tunnelImageDigest)) {
    throw new Error("Each deployment image needs a sha256 digest")
  }
  const agentImage = `${agentImageRepository}@${agentImageDigest}`
  const tunnelImage = `${tunnelImageRepository}@${tunnelImageDigest}`
  if (!IMAGE_PATTERN.test(agentImage) || !IMAGE_PATTERN.test(tunnelImage)) {
    throw new Error("Each deployment image must use a valid repository and sha256 digest")
  }

  const deployment = requiredText(input.deployment, "Kubernetes Deployment manifest")
  const config = requiredText(input.config, "Kubernetes bootstrap ConfigMap")
  const delivery = requiredText(input.delivery, "Kubernetes secret delivery contract")
  const networkPolicy = requiredText(input.networkPolicy, "Kubernetes NetworkPolicy")
  const ciliumPolicy = requiredText(input.ciliumPolicy, "Cilium FQDN policy")
  const serviceAccounts = requiredText(
    input.serviceAccounts,
    "The secret-delivery ServiceAccount manifest"
  )
  const agentPolicy = requiredText(input.agentPolicy, "Pi OAuth OpenBao policy")
  const secretDeliveryPolicy = requiredText(
    input.secretDeliveryPolicy,
    "Secret-delivery OpenBao policy"
  )
  const source = [deployment, config, delivery, networkPolicy, ciliumPolicy].join("\n")
  if (source.includes("local-only")) {
    throw new Error("The Kubernetes contract contains a local-only image")
  }
  if (/imagePullPolicy:\s*Never/u.test(source)) {
    throw new Error("The Kubernetes contract contains imagePullPolicy Never")
  }

  const replacements = {
    OPENBAO_ADDR: requiredText(input.openBaoAddress, "OPENBAO_ADDR"),
    BOB_CORE_FQDN: coreFqdn,
    OPENBAO_FQDN: openBaoFqdn,
    BOB_AGENT_IMAGE_REPOSITORY: agentImageRepository,
    BOB_AGENT_IMAGE_DIGEST: agentImageDigest,
    CLOUDFLARED_IMAGE_REPOSITORY: tunnelImageRepository,
    CLOUDFLARED_IMAGE_DIGEST: tunnelImageDigest
  }
  const renderedDeployment = render(deployment, replacements)
  const renderedConfig = render(config, replacements)
  const renderedDelivery = render(delivery, replacements)
  const renderedCiliumPolicy = render(ciliumPolicy, replacements)
  const rendered = [
    renderedDeployment,
    renderedConfig,
    renderedDelivery,
    networkPolicy,
    renderedCiliumPolicy
  ].join("\n")
  if (/\$\{[A-Z0-9_]+\}/u.test(rendered)) {
    throw new Error("The Kubernetes contract contains unresolved render inputs")
  }

  const images = [...renderedDeployment.matchAll(/^\s*image:\s*["']?([^\s"']+)["']?\s*$/gmu)].map(
    (match) => match[1]
  )
  if (
    images.length === 0 ||
    images.some((image) => image === undefined || !IMAGE_PATTERN.test(image))
  ) {
    throw new Error("Each Kubernetes container image must use an immutable sha256 digest")
  }

  const projectedTokenMarkers = [
    "serviceAccountToken:",
    "audience: openbao",
    "expirationSeconds: 600",
    "path: token",
    "mountPath: /var/run/secrets/kubernetes.io/serviceaccount",
    "readOnly: true"
  ]
  if (
    projectedTokenMarkers.some((marker) => !renderedDeployment.includes(marker)) ||
    renderedDeployment.includes("subPath:")
  ) {
    throw new Error("The bounded projected OpenBao token contract is missing")
  }
  if (
    !renderedDeployment.includes("configMapRef:") ||
    !renderedDeployment.includes("name: bob-agent-bootstrap") ||
    !renderedDeployment.includes("name: bob-agent-tunnel") ||
    !/secretRef:\s*\n\s*name: bob-agent-bootstrap\s*\n\s*optional: false/u.test(renderedDeployment)
  ) {
    throw new Error("The agent bootstrap or Tunnel Secret binding is missing")
  }

  const secretDeliveryMarkers = [
    "apiVersion: external-secrets.io/v1",
    "kind: SecretStore",
    "audiences: [openbao]",
    "role: bob-agent-secret-delivery",
    "name: bob-agent-secret-delivery",
    "kind: ExternalSecret",
    "name: bob-agent-tunnel",
    "property: TUNNEL_TOKEN"
  ]
  if (secretDeliveryMarkers.some((marker) => !renderedDelivery.includes(marker))) {
    throw new Error("The reviewed OpenBao secret delivery contract is missing")
  }
  const secretDeliveryAccount = serviceAccounts
    .split(/^---$/gmu)
    .find((document) => document.includes("name: bob-agent-secret-delivery"))
  if (
    secretDeliveryAccount === undefined ||
    !secretDeliveryAccount.includes("kind: ServiceAccount") ||
    !secretDeliveryAccount.includes("automountServiceAccountToken: false")
  ) {
    throw new Error("The isolated secret-delivery ServiceAccount is missing")
  }
  const accessSecretDeliveryMarkers = [
    "name: bob-agent-bootstrap",
    "path: ops",
    'key: "apps/prod/bob/access/core-to-agent"',
    'key: "apps/prod/bob/access/core-to-agent-admin"',
    'key: "apps/prod/bob/access/agent-to-core"',
    "property: CORE_URL",
    "property: CORE_ACCESS_CLIENT_ID",
    "property: CORE_ACCESS_CLIENT_SECRET",
    "property: ACCESS_TEAM_DOMAIN",
    "property: RUN_ACCESS_AUDIENCE",
    "property: RUN_ACCESS_SUBJECT",
    "property: ADMIN_ACCESS_AUDIENCE",
    "property: ADMIN_ACCESS_SUBJECT"
  ]
  if (accessSecretDeliveryMarkers.some((marker) => !renderedDelivery.includes(marker))) {
    throw new Error("The reviewed Access runtime secret delivery contract is missing")
  }
  const piPath = "apps/prod/bob/pi-auth/openai-codex"
  if (
    !agentPolicy.includes(`path "ops/data/${piPath}"`) ||
    !agentPolicy.includes(`path "ops/metadata/${piPath}"`) ||
    agentPolicy.includes("/access/") ||
    agentPolicy.includes("/tunnel/")
  ) {
    throw new Error("The Pi OAuth OpenBao policy is not isolated")
  }
  const deliveryPaths = [
    "apps/prod/bob/access/core-to-agent",
    "apps/prod/bob/access/core-to-agent-admin",
    "apps/prod/bob/access/agent-to-core",
    "apps/prod/bob/tunnel/agent-host"
  ]
  if (
    deliveryPaths.some((path) => !secretDeliveryPolicy.includes(`path "ops/data/${path}"`)) ||
    secretDeliveryPolicy.includes("pi-auth/openai-codex") ||
    secretDeliveryPolicy.includes("+") ||
    secretDeliveryPolicy.includes("*") ||
    !secretDeliveryPolicy.includes('capabilities = ["read"]')
  ) {
    throw new Error("The secret-delivery OpenBao policy is not exact and read-only")
  }
  if (/port:\s*443/u.test(networkPolicy)) {
    throw new Error("The standard NetworkPolicy must not allow broad HTTPS egress")
  }
  if (
    !renderedCiliumPolicy.includes("requires-cilium-fqdn-enforcement") ||
    !renderedCiliumPolicy.includes(coreFqdn) ||
    !renderedCiliumPolicy.includes(openBaoFqdn)
  ) {
    throw new Error("The reviewed Cilium FQDN enforcement contract is missing")
  }
  return { agentImage, tunnelImage }
}
