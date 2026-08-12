const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[0-9]+)?(?:\/[a-z0-9._/-]+)*@sha256:[a-f0-9]{64}$/u
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u

const production = Object.freeze({
  agentImageRepository: "ghcr.io/arek-e/bob-agent",
  agentImagePlaceholder: "bob-agent.invalid/repository",
  backupImageRepository: "ghcr.io/arek-e/bob-data-backup",
  backupImagePlaceholder: "bob-backup.invalid/repository",
  nangoImage:
    "docker.io/nangohq/nango-server@sha256:a52964a41b5ff5d113e45d8ae76a6ffeb2b76ed6e147bc5078288d0f0c79f0c6",
  nangoImagePlaceholder: "nango.invalid/repository",
  nangoPostgresImage:
    "docker.io/library/postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777",
  nangoPostgresImagePlaceholder: "nango-postgres.invalid/repository",
  nangoRedisImage:
    "docker.io/library/redis@sha256:05a97a479bc73de66f087dc05b569010772880f778cc8671fa6b8aadee32e5c6",
  nangoRedisImagePlaceholder: "nango-redis.invalid/repository",
  tunnelImage:
    "docker.io/cloudflare/cloudflared@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf",
  openBaoAddress: "http://openbao.openbao.svc.cluster.local:8200",
  repository: "git@github.com:arek-e/bob.git",
  repositoryPath: "infra/kubernetes/overlays/prod",
  repositorySecretPath: "apps/prod/bob/argocd/repository"
})

function requiredText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required for deployment readiness`)
  }
  return value
}

function requireMarkers(source, markers, message) {
  if (markers.some((marker) => !source.includes(marker))) {
    throw new Error(message)
  }
}

function pinnedOverlayImage(source, placeholder, repository) {
  const lines = source.split("\n")
  const indexes = lines.flatMap((line, index) =>
    line.trim() === `- name: ${placeholder}` ? [index] : []
  )
  const index = indexes[0]
  const name = index === undefined ? undefined : lines[index + 1]?.trim()
  const digest = index === undefined ? undefined : lines[index + 2]?.trim()
  if (
    indexes.length !== 1 ||
    name !== `newName: ${repository}` ||
    digest === undefined ||
    !DIGEST_PATTERN.test(digest.replace(/^digest:\s*/u, ""))
  ) {
    throw new Error("The production Kustomize overlay has an invalid image pin")
  }
  const digestValue = digest.replace(/^digest:\s*/u, "")
  return { digest: digestValue, image: `${repository}@${digestValue}`, repository }
}

function productionReleaseSha(source) {
  const lines = source.split("\n")
  const indexes = lines.flatMap((line, index) =>
    line.trim() === "path: /data/BOB_RELEASE_SHA" ? [index] : []
  )
  const index = indexes[0]
  const value =
    index === undefined ? undefined : lines[index + 1]?.trim().replace(/^value:\s*/u, "")
  if (indexes.length !== 1 || value === undefined || !COMMIT_PATTERN.test(value)) {
    throw new Error("The production Kustomize overlay needs a full release SHA")
  }
  return value
}

function manifestDocuments(source) {
  return source.split(/^---\s*$/gmu).filter((document) => document.trim().length > 0)
}

function manifestIdentity(document) {
  let kind
  let name
  let namespace
  let inMetadata = false
  for (const line of document.split("\n")) {
    if (line.startsWith("kind: ")) {
      kind = line.slice("kind: ".length)
      continue
    }
    if (line === "metadata:") {
      inMetadata = true
      continue
    }
    if (inMetadata && /^\S/u.test(line)) {
      inMetadata = false
    }
    if (!inMetadata) {
      continue
    }
    if (line.startsWith("  name: ")) {
      name = line.slice("  name: ".length)
    }
    if (line.startsWith("  namespace: ")) {
      namespace = line.slice("  namespace: ".length)
    }
  }
  return { kind, name, namespace }
}

function findManifestObject(source, expected) {
  return manifestDocuments(source).find((document) => {
    const identity = manifestIdentity(document)
    return (
      identity.kind === expected.kind &&
      identity.name === expected.name &&
      (expected.namespace === undefined || identity.namespace === expected.namespace)
    )
  })
}

function requireManifestObject(source, expected, setName) {
  const document = findManifestObject(source, expected)
  if (document === undefined) {
    const namespace = expected.namespace === undefined ? "" : ` in ${expected.namespace}`
    throw new Error(`${setName} is missing ${expected.kind} ${expected.name}${namespace}`)
  }
  return document
}

/**
 * Check the complete production GitOps contract without applying it.
 * The return value contains no credentials.
 *
 * @param {Record<string, unknown>} input
 */
export function assertDeploymentReadiness(input) {
  const deployment = requiredText(input.deployment, "Kubernetes Deployment manifest")
  const config = requiredText(input.config, "Kubernetes bootstrap ConfigMap")
  const delivery = requiredText(input.delivery, "Kubernetes secret delivery contract")
  const backupJob = requiredText(input.backupJob, "Kubernetes backup job contract")
  const backupDelivery = requiredText(
    input.backupDelivery,
    "Kubernetes backup secret delivery contract"
  )
  const backupNetworkPolicy = requiredText(
    input.backupNetworkPolicy,
    "Kubernetes backup network policy"
  )
  const networkPolicy = requiredText(input.networkPolicy, "Kubernetes NetworkPolicy")
  const ciliumPolicy = requiredText(input.ciliumPolicy, "Cilium egress policy")
  const serviceAccounts = requiredText(
    input.serviceAccounts,
    "The secret-delivery ServiceAccount manifest"
  )
  const argocdNamespace = requiredText(input.argocdNamespace, "Argo CD Bob Namespace manifest")
  const agentPolicy = requiredText(input.agentPolicy, "Pi OAuth OpenBao policy")
  const secretDeliveryPolicy = requiredText(
    input.secretDeliveryPolicy,
    "Secret-delivery OpenBao policy"
  )
  const backupSecretDeliveryPolicy = requiredText(
    input.backupSecretDeliveryPolicy,
    "Backup secret-delivery OpenBao policy"
  )
  const productionOverlay = requiredText(input.productionOverlay, "Production Kustomize overlay")
  const kubernetesKustomization = requiredText(
    input.kubernetesKustomization,
    "Production Kubernetes entrypoint"
  )
  const baseKustomization = requiredText(input.baseKustomization, "Generic Kubernetes base")
  const argocdRepository = requiredText(input.argocdRepository, "Argo CD repository ExternalSecret")
  const argocdRepositoryServiceAccount = requiredText(
    input.argocdRepositoryServiceAccount,
    "Argo CD repository ServiceAccount"
  )
  const argocdRepositorySecretStore = requiredText(
    input.argocdRepositorySecretStore,
    "Argo CD repository SecretStore"
  )
  const argocdRepositoryPolicy = requiredText(
    input.argocdRepositoryPolicy,
    "Argo CD repository OpenBao policy"
  )
  const argocdProject = requiredText(input.argocdProject, "Argo CD AppProject")
  const argocdApplication = requiredText(input.argocdApplication, "Argo CD Application")
  const argocdKustomization = requiredText(input.argocdKustomization, "Argo CD Kustomization")
  const renderedKubernetes = requiredText(
    input.renderedKubernetes,
    "Rendered production Kubernetes manifests"
  )
  const renderedArgocd = requiredText(input.renderedArgocd, "Rendered Argo CD bootstrap manifests")
  const coolifyCompose = requiredText(input.coolifyCompose, "Coolify Compose contract")

  const agent = pinnedOverlayImage(
    productionOverlay,
    production.agentImagePlaceholder,
    production.agentImageRepository
  )
  const backup = pinnedOverlayImage(
    productionOverlay,
    production.backupImagePlaceholder,
    production.backupImageRepository
  )
  const releaseSha = productionReleaseSha(productionOverlay)

  const baseSource = [
    deployment,
    config,
    delivery,
    networkPolicy,
    ciliumPolicy,
    backupJob,
    backupDelivery,
    backupNetworkPolicy
  ].join("\n")
  if (baseSource.includes("local-only")) {
    throw new Error("The Kubernetes contract contains a local-only image")
  }
  if (/imagePullPolicy:\s*Never/u.test(baseSource)) {
    throw new Error("The Kubernetes contract contains imagePullPolicy Never")
  }
  requireMarkers(
    deployment,
    [`image: ${production.agentImagePlaceholder}`],
    "The generic image placeholders are missing"
  )
  requireMarkers(
    backupJob,
    [`image: ${production.backupImagePlaceholder}`],
    "The generic backup image placeholder is missing"
  )
  if (
    deployment.includes(agent.image) ||
    backupJob.includes(backup.image) ||
    config.includes(production.openBaoAddress) ||
    delivery.includes(production.openBaoAddress)
  ) {
    throw new Error("A production value escaped the production overlay")
  }

  const { repository: agentRepository, digest: agentDigest } = agent
  const { repository: backupRepository, digest: backupDigest } = backup
  const [nangoRepository, nangoDigest] = production.nangoImage.split("@")
  const [nangoPostgresRepository, nangoPostgresDigest] = production.nangoPostgresImage.split("@")
  const [nangoRedisRepository, nangoRedisDigest] = production.nangoRedisImage.split("@")
  const [tunnelRepository, tunnelDigest] = production.tunnelImage.split("@")
  if (
    nangoRepository === undefined ||
    nangoPostgresRepository === undefined ||
    nangoRedisRepository === undefined ||
    tunnelRepository === undefined ||
    nangoDigest === undefined ||
    nangoPostgresDigest === undefined ||
    nangoRedisDigest === undefined ||
    tunnelDigest === undefined ||
    !DIGEST_PATTERN.test(nangoDigest) ||
    !DIGEST_PATTERN.test(nangoPostgresDigest) ||
    !DIGEST_PATTERN.test(nangoRedisDigest) ||
    !DIGEST_PATTERN.test(tunnelDigest)
  ) {
    throw new Error("Each production image needs a sha256 digest")
  }
  requireMarkers(
    productionOverlay,
    [
      "kind: Kustomization",
      "- ../../base",
      `- name: ${production.agentImagePlaceholder}`,
      `newName: ${agentRepository}`,
      `digest: ${agentDigest}`,
      `- name: ${production.backupImagePlaceholder}`,
      `newName: ${backupRepository}`,
      `digest: ${backupDigest}`,
      `- name: ${production.nangoImagePlaceholder}`,
      `newName: ${nangoRepository}`,
      `digest: ${nangoDigest}`,
      `- name: ${production.nangoPostgresImagePlaceholder}`,
      `newName: ${nangoPostgresRepository}`,
      `digest: ${nangoPostgresDigest}`,
      `- name: ${production.nangoRedisImagePlaceholder}`,
      `newName: ${nangoRedisRepository}`,
      `digest: ${nangoRedisDigest}`,
      "kind: ConfigMap",
      "name: bob-agent-bootstrap",
      "path: /data/BAO_ADDR",
      `value: ${production.openBaoAddress}`,
      "replacements:",
      "fieldPath: data.BAO_ADDR",
      "kind: SecretStore",
      "name: bob-openbao",
      "name: bob-backup-openbao",
      "spec.provider.vault.server"
    ],
    "The literal production Kustomize overlay is incomplete"
  )
  if (productionOverlay.includes("staging") || /\$\{[A-Z0-9_]+\}/u.test(productionOverlay)) {
    throw new Error("The production overlay contains a stage or unresolved input")
  }
  requireMarkers(
    coolifyCompose,
    ["tunnel:", `image: ${production.tunnelImage}`],
    "The Coolify production Tunnel image is missing or mutable"
  )
  if (
    !kubernetesKustomization.includes("- overlays/prod") ||
    kubernetesKustomization.includes("- base")
  ) {
    throw new Error("The Kubernetes entrypoint must render only the production overlay")
  }
  if (baseKustomization.includes("namespace.yaml")) {
    throw new Error("The Argo-managed Kubernetes base must not own the Bob Namespace")
  }

  const renderedSource = [renderedKubernetes, renderedArgocd].join("\n")
  if (
    /\$\{[A-Z0-9_]+\}/u.test(renderedSource) ||
    /(?:bob-agent|bob-backup|cloudflared|nango|nango-postgres|nango-redis)\.invalid\/repository/u.test(
      renderedSource
    ) ||
    /(?:local-only|REPLACE_WITH|replace-me|changeme)/iu.test(renderedSource)
  ) {
    throw new Error("A rendered production manifest contains an unresolved or invalid input")
  }

  const requiredKubernetesObjects = [
    { kind: "ConfigMap", name: "bob-agent-bootstrap", namespace: "bob" },
    { kind: "ServiceAccount", name: "bob-agent", namespace: "bob" },
    { kind: "ServiceAccount", name: "bob-agent-secret-delivery", namespace: "bob" },
    { kind: "ServiceAccount", name: "bob-backup", namespace: "bob" },
    { kind: "ServiceAccount", name: "bob-backup-secret-delivery", namespace: "bob" },
    { kind: "Deployment", name: "bob-agent", namespace: "bob" },
    { kind: "Service", name: "bob-agent", namespace: "bob" },
    { kind: "SecretStore", name: "bob-openbao", namespace: "bob" },
    { kind: "ExternalSecret", name: "bob-agent-bootstrap", namespace: "bob" },
    { kind: "ExternalSecret", name: "bob-agent-tunnel", namespace: "bob" },
    { kind: "ExternalSecret", name: "bob-ghcr-pull", namespace: "bob" },
    { kind: "SecretStore", name: "bob-backup-openbao", namespace: "bob" },
    { kind: "ExternalSecret", name: "bob-backup-runtime", namespace: "bob" },
    { kind: "PersistentVolumeClaim", name: "bob-backups", namespace: "bob" },
    { kind: "CronJob", name: "bob-data-backup", namespace: "bob" },
    { kind: "NetworkPolicy", name: "bob-data-backup-default-deny", namespace: "bob" },
    {
      kind: "CiliumNetworkPolicy",
      name: "bob-data-backup-reviewed-egress",
      namespace: "bob"
    },
    { kind: "NetworkPolicy", name: "bob-agent-restricted-network", namespace: "bob" },
    {
      kind: "CiliumNetworkPolicy",
      name: "bob-agent-reviewed-egress",
      namespace: "bob"
    }
  ]
  for (const expected of requiredKubernetesObjects) {
    requireManifestObject(renderedKubernetes, expected, "The production Kubernetes render")
  }
  if (findManifestObject(renderedKubernetes, { kind: "Namespace", name: "bob" }) !== undefined) {
    throw new Error("The Argo-managed production render must not own the Bob Namespace")
  }

  const requiredArgocdObjects = [
    { kind: "Namespace", name: "bob" },
    { kind: "ServiceAccount", name: "bob-argocd-repository", namespace: "argocd" },
    { kind: "SecretStore", name: "bob-argocd-repository", namespace: "argocd" },
    { kind: "ExternalSecret", name: "bob-repository", namespace: "argocd" },
    { kind: "AppProject", name: "bob", namespace: "argocd" },
    { kind: "Application", name: "bob", namespace: "argocd" }
  ]
  for (const expected of requiredArgocdObjects) {
    requireManifestObject(renderedArgocd, expected, "The Argo CD bootstrap render")
  }

  const renderedDeployment = requireManifestObject(
    renderedKubernetes,
    { kind: "Deployment", name: "bob-agent", namespace: "bob" },
    "The production Kubernetes render"
  )
  const renderedConfig = requireManifestObject(
    renderedKubernetes,
    { kind: "ConfigMap", name: "bob-agent-bootstrap", namespace: "bob" },
    "The production Kubernetes render"
  )
  const renderedSecretStore = requireManifestObject(
    renderedKubernetes,
    { kind: "SecretStore", name: "bob-openbao", namespace: "bob" },
    "The production Kubernetes render"
  )
  const renderedCiliumPolicy = requireManifestObject(
    renderedKubernetes,
    {
      kind: "CiliumNetworkPolicy",
      name: "bob-agent-reviewed-egress",
      namespace: "bob"
    },
    "The production Kubernetes render"
  )
  const renderedBackupJob = requireManifestObject(
    renderedKubernetes,
    { kind: "CronJob", name: "bob-data-backup", namespace: "bob" },
    "The production Kubernetes render"
  )
  const renderedBackupClaim = requireManifestObject(
    renderedKubernetes,
    { kind: "PersistentVolumeClaim", name: "bob-backups", namespace: "bob" },
    "The production Kubernetes render"
  )
  const renderedBackupCiliumPolicy = requireManifestObject(
    renderedKubernetes,
    {
      kind: "CiliumNetworkPolicy",
      name: "bob-data-backup-reviewed-egress",
      namespace: "bob"
    },
    "The production Kubernetes render"
  )
  const images = [...renderedKubernetes.matchAll(/^\s*image:\s*["']?([^\s"']+)["']?\s*$/gmu)].map(
    (match) => match[1]
  )
  if (
    images.length !== 5 ||
    images.some((image) => image === undefined || !IMAGE_PATTERN.test(image)) ||
    !images.includes(agent.image) ||
    !images.includes(backup.image) ||
    !images.includes(production.nangoImage) ||
    !images.includes(production.nangoPostgresImage) ||
    !images.includes(production.nangoRedisImage) ||
    images.includes(production.tunnelImage)
  ) {
    throw new Error("Each production container image must use its reviewed sha256 digest")
  }
  if (
    !renderedConfig.includes(`BAO_ADDR: ${production.openBaoAddress}`) ||
    !renderedConfig.includes(`BOB_RELEASE_SHA: ${releaseSha}`) ||
    !renderedSecretStore.includes(`server: ${production.openBaoAddress}`)
  ) {
    throw new Error("The in-cluster OpenBao address is missing")
  }
  const projectedTokenMarkers = [
    "serviceAccountToken:",
    "audience: openbao",
    "expirationSeconds: 600",
    "path: token",
    "mountPath: /var/run/secrets/kubernetes.io/serviceaccount",
    "readOnly: true",
    "fsGroup: 1000",
    "fsGroupChangePolicy: OnRootMismatch",
    "defaultMode: 288"
  ]
  if (
    projectedTokenMarkers.some((marker) => !renderedDeployment.includes(marker)) ||
    renderedDeployment.includes("subPath:")
  ) {
    throw new Error("The bounded projected OpenBao token contract is missing")
  }
  if (
    !renderedDeployment.includes("runAsNonRoot: true") ||
    !renderedDeployment.includes("runAsUser: 1000") ||
    !renderedDeployment.includes("runAsGroup: 1000")
  ) {
    throw new Error("The agent container needs an exact non-root identity")
  }
  if (
    !renderedDeployment.includes("configMapRef:") ||
    !renderedDeployment.includes("name: bob-agent-bootstrap") ||
    !renderedDeployment.includes("imagePullSecrets:") ||
    !renderedDeployment.includes("name: bob-ghcr-pull") ||
    !/secretRef:\s*\n\s*name: bob-agent-bootstrap\s*\n\s*optional: false/u.test(renderedDeployment)
  ) {
    throw new Error("The agent bootstrap or registry pull binding is missing")
  }

  const secretDeliveryMarkers = [
    "apiVersion: external-secrets.io/v1",
    "kind: SecretStore",
    "audiences: [openbao]",
    "role: bob-agent-secret-delivery",
    "name: bob-agent-secret-delivery",
    "kind: ExternalSecret",
    "name: bob-agent-tunnel",
    "property: TUNNEL_TOKEN",
    "name: bob-ghcr-pull",
    "type: kubernetes.io/dockerconfigjson",
    'key: "apps/prod/bob/registry/ghcr"',
    "property: USERNAME",
    "property: TOKEN"
  ]
  requireMarkers(
    delivery,
    secretDeliveryMarkers,
    "The reviewed OpenBao secret delivery contract is missing"
  )
  requireMarkers(
    backupDelivery,
    [
      "kind: SecretStore",
      "name: bob-backup-openbao",
      "role: bob-backup-secret-delivery",
      "name: bob-backup-secret-delivery",
      "audiences: [openbao]",
      "kind: ExternalSecret",
      "name: bob-backup-runtime",
      'key: "apps/prod/bob/backup/runtime"',
      "property: CLOUDFLARE_ACCOUNT_ID",
      "property: CLOUDFLARE_D1_DATABASE_ID",
      "property: CLOUDFLARE_API_TOKEN",
      "property: R2_BUCKET",
      "property: R2_ENDPOINT",
      "property: R2_ACCESS_KEY_ID",
      "property: R2_SECRET_ACCESS_KEY",
      "property: BACKUP_AGE_RECIPIENT"
    ],
    "The backup secret delivery contract is missing"
  )
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
  for (const name of ["bob-backup", "bob-backup-secret-delivery"]) {
    const account = serviceAccounts
      .split(/^---$/gmu)
      .find((document) => document.includes(`name: ${name}`))
    if (
      account === undefined ||
      !account.includes("kind: ServiceAccount") ||
      !account.includes("automountServiceAccountToken: false")
    ) {
      throw new Error("The isolated backup ServiceAccounts are missing")
    }
  }
  requireMarkers(
    argocdNamespace,
    [
      "kind: Namespace",
      "name: bob",
      "pod-security.kubernetes.io/enforce: restricted",
      "pod-security.kubernetes.io/enforce-version: v1.32",
      "pod-security.kubernetes.io/audit: restricted",
      "pod-security.kubernetes.io/audit-version: v1.32",
      "pod-security.kubernetes.io/warn: restricted",
      "pod-security.kubernetes.io/warn-version: v1.32"
    ],
    "The Bob namespace restricted Pod Security contract is missing"
  )
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
  requireMarkers(
    delivery,
    accessSecretDeliveryMarkers,
    "The reviewed Access runtime secret delivery contract is missing"
  )

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
    "apps/prod/bob/tunnel/agent-host",
    "apps/prod/bob/registry/ghcr"
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
  if (
    !backupSecretDeliveryPolicy.includes('path "ops/data/apps/prod/bob/backup/runtime"') ||
    !backupSecretDeliveryPolicy.includes('capabilities = ["read"]') ||
    (backupSecretDeliveryPolicy.match(/^path\s+"/gmu) ?? []).length !== 1 ||
    backupSecretDeliveryPolicy.includes("+") ||
    backupSecretDeliveryPolicy.includes("*")
  ) {
    throw new Error("The backup secret-delivery OpenBao policy is not exact and read-only")
  }
  requireMarkers(
    backupJob,
    ['schedule: "15 */4 * * *"', "concurrencyPolicy: Forbid"],
    "The scheduled backup source contract is incomplete"
  )
  requireMarkers(
    renderedBackupJob,
    [
      "schedule: 15 */4 * * *",
      "concurrencyPolicy: Forbid",
      "activeDeadlineSeconds: 3600",
      "backoffLimit: 2",
      "serviceAccountName: bob-backup",
      "name: bob-ghcr-pull",
      "name: bob-backup-runtime",
      "readOnlyRootFilesystem: true",
      "runAsNonRoot: true",
      "mountPath: /backups",
      "claimName: bob-backups"
    ],
    "The encrypted scheduled backup contract is incomplete"
  )
  requireMarkers(
    renderedBackupClaim,
    [
      "argocd.argoproj.io/sync-options: Prune=false",
      "storageClassName: local-path",
      "storage: 16Gi"
    ],
    "The retained independent backup volume is incomplete"
  )
  if (/port:\s*443/u.test(networkPolicy)) {
    throw new Error("The standard NetworkPolicy must not allow broad HTTPS egress")
  }
  requireMarkers(
    renderedCiliumPolicy,
    [
      "requires-cilium-egress-enforcement",
      "k8s:io.kubernetes.pod.namespace: kube-system",
      "k8s:k8s-app: kube-dns",
      "toCIDRSet:",
      "cidr: 0.0.0.0/0",
      "except:",
      "- 0.0.0.0/8",
      "- 10.0.0.0/8",
      "- 100.64.0.0/10",
      "- 127.0.0.0/8",
      "- 169.254.0.0/16",
      "- 172.16.0.0/12",
      "- 192.0.0.0/24",
      "- 192.0.2.0/24",
      "- 192.88.99.0/24",
      "- 192.168.0.0/16",
      "- 198.18.0.0/15",
      "- 198.51.100.0/24",
      "- 203.0.113.0/24",
      "- 224.0.0.0/4",
      "- 240.0.0.0/4",
      '- port: "53"',
      '- port: "443"'
    ],
    "The reviewed Cilium egress contract is missing"
  )
  if (renderedCiliumPolicy.includes("rules:") || renderedCiliumPolicy.includes("toFQDNs:")) {
    throw new Error("The production policy must not depend on the Cilium DNS proxy")
  }
  if (
    !backupNetworkPolicy.includes("ingress: []") ||
    !backupNetworkPolicy.includes("egress: []") ||
    renderedBackupCiliumPolicy.includes("rules:") ||
    renderedBackupCiliumPolicy.includes("toFQDNs:")
  ) {
    throw new Error("The backup network policy is incomplete")
  }
  requireMarkers(
    renderedBackupCiliumPolicy,
    [
      "requires-cilium-egress-enforcement",
      "k8s:k8s-app: kube-dns",
      "toCIDRSet:",
      "cidr: 0.0.0.0/0",
      "- 0.0.0.0/8",
      "- 10.0.0.0/8",
      "- 100.64.0.0/10",
      "- 127.0.0.0/8",
      "- 169.254.0.0/16",
      "- 172.16.0.0/12",
      "- 192.0.0.0/24",
      "- 192.0.2.0/24",
      "- 192.88.99.0/24",
      "- 192.168.0.0/16",
      "- 198.18.0.0/15",
      "- 198.51.100.0/24",
      "- 203.0.113.0/24",
      "- 224.0.0.0/4",
      "- 240.0.0.0/4",
      '- port: "53"',
      '- port: "443"'
    ],
    "The reviewed backup Cilium egress contract is missing"
  )

  requireMarkers(
    argocdRepository,
    [
      "kind: ExternalSecret",
      "name: bob-repository",
      "namespace: argocd",
      "name: bob-argocd-repository",
      "kind: SecretStore",
      "creationPolicy: Owner",
      "argocd.argoproj.io/secret-type: repository",
      "type: git",
      `url: ${production.repository}`,
      'sshPrivateKey: "{{ .sshPrivateKey }}"',
      `key: ${production.repositorySecretPath}`,
      "property: SSH_PRIVATE_KEY"
    ],
    "The Argo CD repository credential delivery contract is incomplete"
  )
  if (/BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY/u.test(argocdRepository)) {
    throw new Error("The Argo CD repository manifest contains private key material")
  }
  requireMarkers(
    argocdRepositoryServiceAccount,
    [
      "kind: ServiceAccount",
      "name: bob-argocd-repository",
      "namespace: argocd",
      "automountServiceAccountToken: false"
    ],
    "The isolated Argo CD repository ServiceAccount is incomplete"
  )
  requireMarkers(
    argocdRepositorySecretStore,
    [
      "kind: SecretStore",
      "name: bob-argocd-repository",
      "namespace: argocd",
      `server: ${production.openBaoAddress}`,
      "path: ops",
      "version: v2",
      "mountPath: kubernetes",
      "role: bob-argocd-repository",
      "serviceAccountRef:",
      "audiences: [openbao]"
    ],
    "The isolated Argo CD repository SecretStore is incomplete"
  )
  if (
    argocdRepositorySecretStore.includes("ClusterSecretStore") ||
    argocdRepositorySecretStore.includes("openbao-store")
  ) {
    throw new Error("The Argo CD repository delivery must not use a shared SecretStore")
  }
  const repositoryPolicyPath = 'path "ops/data/apps/prod/bob/argocd/repository"'
  if (
    !argocdRepositoryPolicy.includes(repositoryPolicyPath) ||
    !argocdRepositoryPolicy.includes('capabilities = ["read"]') ||
    (argocdRepositoryPolicy.match(/^path\s+"/gmu) ?? []).length !== 1 ||
    argocdRepositoryPolicy.includes("+") ||
    argocdRepositoryPolicy.includes("*")
  ) {
    throw new Error("The Argo CD repository OpenBao policy is not exact and read-only")
  }
  requireMarkers(
    argocdProject,
    [
      "kind: AppProject",
      "name: bob",
      `- ${production.repository}`,
      "server: https://kubernetes.default.svc",
      "namespace: bob",
      'group: ""',
      "kind: ConfigMap",
      "kind: Service",
      "kind: ServiceAccount",
      "kind: PersistentVolumeClaim",
      "group: apps",
      "kind: Deployment",
      "group: batch",
      "kind: CronJob",
      "group: networking.k8s.io",
      "kind: NetworkPolicy",
      "group: external-secrets.io",
      "kind: ExternalSecret",
      "kind: SecretStore",
      "group: cilium.io",
      "kind: CiliumNetworkPolicy"
    ],
    "The Bob AppProject resource scope is incomplete"
  )
  if (
    argocdProject.includes("clusterResourceWhitelist:") ||
    argocdProject.includes("kind: Namespace") ||
    /kind:\s*["']?\*["']?/u.test(argocdProject) ||
    /namespace:\s*["']?\*["']?/u.test(argocdProject)
  ) {
    throw new Error("The Bob AppProject contains a wildcard resource scope")
  }

  requireMarkers(
    argocdApplication,
    [
      "kind: Application",
      "name: bob",
      "project: bob",
      `repoURL: ${production.repository}`,
      `path: ${production.repositoryPath}`,
      "server: https://kubernetes.default.svc",
      "namespace: bob",
      "automated:",
      "prune: true",
      "selfHeal: true",
      "allowEmpty: false",
      "ServerSideApply=true",
      "PruneLast=true"
    ],
    "The automated Bob Argo CD Application is incomplete"
  )
  const revision = argocdApplication.match(/^\s*targetRevision:\s*([^\s]+)\s*$/mu)?.[1]
  if (revision === undefined || !COMMIT_PATTERN.test(revision)) {
    throw new Error("The Argo CD target revision must be a reviewed commit")
  }
  requireMarkers(
    argocdKustomization,
    [
      "namespace.yaml",
      "repository-service-account.yaml",
      "repository-secret-store.yaml",
      "repository-external-secret.yaml",
      "project.yaml",
      "application.yaml"
    ],
    "The Argo CD bootstrap Kustomization is incomplete"
  )

  return {
    agentImage: agent.image,
    backupImage: backup.image,
    releaseSha,
    tunnelImage: production.tunnelImage,
    openBaoAddress: production.openBaoAddress,
    targetRevision: revision
  }
}
