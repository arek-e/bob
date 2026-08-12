import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { AGENT_LISTEN_HOST } from "../src/listener.ts"

const kubernetesBase = "infra/kubernetes/base"

describe("agent platform contract", () => {
  it("listens on the pod network for Service and probe traffic", async () => {
    expect(AGENT_LISTEN_HOST).toBe("0.0.0.0")
    const service = await readFile(`${kubernetesBase}/service.yaml`, "utf8")
    const deployment = await readFile(`${kubernetesBase}/deployment.yaml`, "utf8")
    expect(service).toContain("targetPort: http")
    expect(deployment).toContain("containerPort: 8787")
    expect(deployment).toContain("path: /health")
  })

  it("denies default egress and permits only reviewed platform paths", async () => {
    const policy = await readFile(`${kubernetesBase}/network-policy.yaml`, "utf8")
    const ciliumPolicy = await readFile(`${kubernetesBase}/cilium-egress-policy.yaml`, "utf8")
    const deployment = await readFile(`${kubernetesBase}/deployment.yaml`, "utf8")
    expect(policy).toContain("policyTypes: [Ingress, Egress]")
    expect(policy).toContain("kubernetes.io/metadata.name: kube-system")
    expect(policy).toContain("k8s-app: kube-dns")
    expect(policy).toContain("port: 53")
    expect(policy).toContain("kubernetes.io/metadata.name: openbao")
    expect(policy).toContain("port: 7844")
    expect(ciliumPolicy).toContain('"k8s:k8s-app": kube-dns')
    expect(ciliumPolicy).toContain("toCIDRSet:")
    expect(ciliumPolicy).toContain("cidr: 0.0.0.0/0")
    expect(ciliumPolicy).toContain('port: "53"')
    expect(ciliumPolicy).toContain('port: "443"')
    expect(ciliumPolicy).not.toContain("rules:")
    expect(ciliumPolicy).not.toContain("toFQDNs:")
    expect(deployment).not.toContain("name: tunnel")
  })

  it("bootstraps the restricted Bob namespace outside the Argo-managed workload", async () => {
    const [base, bootstrap, namespace, project] = await Promise.all([
      readFile(`${kubernetesBase}/kustomization.yaml`, "utf8"),
      readFile("infra/argocd/kustomization.yaml", "utf8"),
      readFile("infra/argocd/namespace.yaml", "utf8"),
      readFile("infra/argocd/project.yaml", "utf8")
    ])

    expect(base).not.toContain("namespace.yaml")
    expect(bootstrap).toContain("namespace.yaml")
    expect(namespace).toContain("pod-security.kubernetes.io/enforce: restricted")
    expect(namespace).toContain("pod-security.kubernetes.io/audit: restricted")
    expect(namespace).toContain("pod-security.kubernetes.io/warn: restricted")
    expect(project).not.toContain("clusterResourceWhitelist")
    expect(project).not.toContain("kind: Namespace")
  })

  it("mounts one bounded OpenBao audience token at the configured client path", async () => {
    const deployment = await readFile(`${kubernetesBase}/deployment.yaml`, "utf8")
    expect(deployment).toContain("serviceAccountToken:")
    expect(deployment).toContain("audience: openbao")
    expect(deployment).toContain("expirationSeconds: 600")
    expect(deployment).toContain("path: token")
    expect(deployment).toContain("mountPath: /var/run/secrets/kubernetes.io/serviceaccount")
    expect(deployment).not.toContain("subPath:")
    expect(deployment).toContain("readOnly: true")
    expect(deployment).toContain("fsGroup: 1000")
    expect(deployment).toContain("fsGroupChangePolicy: OnRootMismatch")
    expect(deployment).toContain("defaultMode: 0440")
  })

  it("declares reviewed OpenBao-to-Kubernetes secret delivery", async () => {
    const delivery = await readFile(`${kubernetesBase}/secret-delivery.yaml`, "utf8")
    const deployment = await readFile(`${kubernetesBase}/deployment.yaml`, "utf8")
    expect(delivery).toContain("apiVersion: external-secrets.io/v1")
    expect(delivery).toContain("kind: SecretStore")
    expect(delivery).toContain("path: ops")
    expect(delivery).toContain("audiences: [openbao]")
    expect(delivery).toContain("kind: ExternalSecret")
    expect(delivery).toContain("name: bob-agent-tunnel")
    expect(delivery).toContain("property: TUNNEL_TOKEN")
    expect(deployment).toContain("configMapRef:")
    expect(deployment).toContain("name: bob-agent-bootstrap")
  })

  it("delivers all Access runtime records before the agent container starts", async () => {
    const delivery = await readFile(`${kubernetesBase}/secret-delivery.yaml`, "utf8")
    const deployment = await readFile(`${kubernetesBase}/deployment.yaml`, "utf8")
    const schema = await readFile("apps/agent/.env.schema", "utf8")

    expect(delivery).toContain("name: bob-agent-bootstrap")
    expect(delivery).toContain('key: "apps/prod/bob/access/core-to-agent"')
    expect(delivery).toContain('key: "apps/prod/bob/access/core-to-agent-admin"')
    expect(delivery).toContain('key: "apps/prod/bob/access/agent-to-core"')
    for (const property of [
      "CORE_URL",
      "CORE_ACCESS_CLIENT_ID",
      "CORE_ACCESS_CLIENT_SECRET",
      "ACCESS_TEAM_DOMAIN",
      "RUN_ACCESS_AUDIENCE",
      "RUN_ACCESS_SUBJECT",
      "ADMIN_ACCESS_AUDIENCE",
      "ADMIN_ACCESS_SUBJECT"
    ]) {
      expect(delivery).toContain(`property: ${property}`)
      expect(schema).toMatch(new RegExp(`^${property}=$`, "mu"))
    }
    expect(schema).not.toContain('vaultSecret("access/')
    expect(schema).not.toContain("@initHcpVault")
    expect(deployment).toContain("secretRef:")
    expect(deployment).toContain("name: bob-agent-bootstrap")
    expect(deployment).toContain("optional: false")
  })

  it("delivers a private GHCR pull secret only to the kubelet", async () => {
    const delivery = await readFile(`${kubernetesBase}/secret-delivery.yaml`, "utf8")
    const deployment = await readFile(`${kubernetesBase}/deployment.yaml`, "utf8")
    const deliveryPolicy = await readFile(
      "infra/openbao/agent-secret-delivery-production-policy.hcl",
      "utf8"
    )

    expect(delivery).toContain("name: bob-ghcr-pull")
    expect(delivery).toContain("type: kubernetes.io/dockerconfigjson")
    expect(delivery).toContain('key: "apps/prod/bob/registry/ghcr"')
    expect(delivery).toContain("property: USERNAME")
    expect(delivery).toContain("property: TOKEN")
    expect(deployment).toContain("imagePullSecrets:")
    expect(deployment).toContain("name: bob-ghcr-pull")
    expect(deliveryPolicy).toContain('path "ops/data/apps/prod/bob/registry/ghcr"')
    expect(deployment).not.toContain("GHCR")
  })

  it("separates runtime secret delivery from the Pi OAuth identity", async () => {
    const accounts = await readFile(`${kubernetesBase}/service-account.yaml`, "utf8")
    const delivery = await readFile(`${kubernetesBase}/secret-delivery.yaml`, "utf8")
    const agentPolicy = await readFile("infra/openbao/agent-production-policy.hcl", "utf8")
    const deliveryPolicy = await readFile(
      "infra/openbao/agent-secret-delivery-production-policy.hcl",
      "utf8"
    )

    expect(accounts).toContain("name: bob-agent-secret-delivery")
    expect(delivery).toContain("role: bob-agent-secret-delivery")
    expect(delivery).toContain("name: bob-agent-secret-delivery")
    expect(agentPolicy).toContain("pi-auth/openai-codex")
    expect(agentPolicy).toContain('path "ops/data/apps/prod/bob/pi-auth/openai-codex"')
    expect(agentPolicy).toContain('path "ops/metadata/apps/prod/bob/pi-auth/openai-codex"')
    expect(agentPolicy).not.toContain("/access/")
    expect(agentPolicy).not.toContain("/tunnel/")
    expect(deliveryPolicy).toContain("/access/core-to-agent")
    expect(deliveryPolicy).toContain("/access/core-to-agent-admin")
    expect(deliveryPolicy).toContain("/access/agent-to-core")
    expect(deliveryPolicy).toContain("/tunnel/agent-host")
    expect(deliveryPolicy).toContain('path "ops/data/apps/prod/bob/access/core-to-agent"')
    expect(deliveryPolicy).not.toContain("pi-auth/openai-codex")
  })

  it("keeps Pi OAuth in the OpenBao-backed Node credential store", async () => {
    const composition = await readFile("apps/agent/src/composition.ts", "utf8")

    expect(composition).toContain("new OpenBaoCredentialStore")
    expect(composition).toContain("getKubernetesJwt")
    expect(composition).toContain("getAppRoleSecretId")
    expect(composition).toContain("config.baoAuthentication")
  })

  it("does not inject deployment stage values into the agent", async () => {
    const packageManifest = await readFile("apps/agent/package.json", "utf8")
    const schema = await readFile("apps/agent/.env.schema", "utf8")
    const bootstrap = await readFile(`${kubernetesBase}/agent-config.yaml`, "utf8")

    expect(packageManifest).not.toContain("--include-internal")
    expect(schema).not.toContain("BOB_SECRET_STAGE")
    expect(schema).not.toContain("BOB_STAGE")
    expect(bootstrap).not.toContain("BOB_SECRET_STAGE")
    expect(bootstrap).not.toContain("BOB_STAGE")
  })

  it("builds a bounded production image from the bundled agent", async () => {
    const dockerfile = await readFile("apps/agent/Dockerfile", "utf8")
    const dockerignore = await readFile(".dockerignore", "utf8")
    const packageManifest = await readFile("apps/agent/package.json", "utf8")
    const piAgentSource = await readFile("packages/pi-agent/src/index.ts", "utf8")

    expect(dockerfile).not.toContain("COPY --from=build --chown=node:node /app /app")
    expect(dockerfile).toContain("COPY --from=build --chown=node:node /runtime /app")
    expect(dockerfile).toContain("dist/index.cjs")
    expect(dockerfile).not.toContain("dist/index.js")
    expect(dockerfile).toContain("apps/agent/src/environment.generated.ts")
    expect(packageManifest).toContain(
      '"start": "varlock run --inject vars --skip-cache -- node dist/index.cjs"'
    )
    expect(packageManifest).toMatch(/"varlock": "1\.16\.1"/u)
    expect(packageManifest).not.toContain("tsx src/index.ts")
    expect(packageManifest).toContain("--format=cjs")
    expect(dockerignore).toContain(".varlock/*")
    expect(dockerignore).toContain("!.varlock/config.json")
    expect(dockerignore).toContain("!**/.env.schema")
    expect(piAgentSource).toContain("registerBunOAuthFlows()")
    expect(packageManifest).toContain("verify-agent-bundle.mjs")
  })

  it("runs the named image user with an exact non-root identity", async () => {
    const deployment = await readFile(`${kubernetesBase}/deployment.yaml`, "utf8")

    expect(deployment).toContain("runAsUser: 1000")
    expect(deployment).toContain("runAsGroup: 1000")
  })

  it("does not regenerate TypeScript files during read-only startup", async () => {
    const schema = await readFile("apps/agent/.env.schema", "utf8")

    expect(schema).toContain(
      "@generateTsTypes(path=./src/environment.generated.ts, exposeEnv=local, auto=false)"
    )
  })
})
