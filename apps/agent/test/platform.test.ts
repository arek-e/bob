import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import { AGENT_LISTEN_HOST } from "../src/listener.ts"

describe("agent platform contract", () => {
  it("listens on the pod network for Service and probe traffic", async () => {
    expect(AGENT_LISTEN_HOST).toBe("0.0.0.0")
    const service = await readFile("infra/kubernetes/service.yaml", "utf8")
    const deployment = await readFile("infra/kubernetes/deployment.yaml", "utf8")
    expect(service).toContain("targetPort: http")
    expect(deployment).toContain("containerPort: 8787")
    expect(deployment).toContain("path: /health")
  })

  it("denies default egress and permits only named platform paths", async () => {
    const policy = await readFile("infra/kubernetes/network-policy.yaml", "utf8")
    expect(policy).toContain("policyTypes: [Ingress, Egress]")
    expect(policy).toContain("kubernetes.io/metadata.name: kube-system")
    expect(policy).toContain("kubernetes.io/metadata.name: openbao")
    expect(policy).toContain("port: 7844")
  })

  it("mounts one bounded OpenBao audience token at the configured client path", async () => {
    const deployment = await readFile("infra/kubernetes/deployment.yaml", "utf8")
    expect(deployment).toContain("serviceAccountToken:")
    expect(deployment).toContain("audience: openbao")
    expect(deployment).toContain("expirationSeconds: 600")
    expect(deployment).toContain("path: token")
    expect(deployment).toContain("mountPath: /var/run/secrets/kubernetes.io/serviceaccount")
    expect(deployment).not.toContain("subPath:")
    expect(deployment).toContain("readOnly: true")
  })

  it("declares reviewed OpenBao-to-Kubernetes secret delivery", async () => {
    const delivery = await readFile("infra/kubernetes/secret-delivery.yaml", "utf8")
    const deployment = await readFile("infra/kubernetes/deployment.yaml", "utf8")
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
    const delivery = await readFile("infra/kubernetes/secret-delivery.yaml", "utf8")
    const deployment = await readFile("infra/kubernetes/deployment.yaml", "utf8")
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

  it("separates runtime secret delivery from the Pi OAuth identity", async () => {
    const accounts = await readFile("infra/kubernetes/service-account.yaml", "utf8")
    const delivery = await readFile("infra/kubernetes/secret-delivery.yaml", "utf8")
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

  it("keeps Pi OAuth in the Kubernetes-aware Node credential store", async () => {
    const composition = await readFile("apps/agent/src/composition.ts", "utf8")

    expect(composition).toContain("new OpenBaoCredentialStore")
    expect(composition).toContain("getKubernetesJwt")
    expect(composition).toContain("baoKubernetesJwtPath")
  })

  it("does not inject deployment stage values into the agent", async () => {
    const packageManifest = await readFile("apps/agent/package.json", "utf8")
    const schema = await readFile("apps/agent/.env.schema", "utf8")
    const bootstrap = await readFile("infra/kubernetes/agent-config.yaml", "utf8")

    expect(packageManifest).not.toContain("--include-internal")
    expect(schema).not.toContain("BOB_SECRET_STAGE")
    expect(schema).not.toContain("BOB_STAGE")
    expect(bootstrap).not.toContain("BOB_SECRET_STAGE")
    expect(bootstrap).not.toContain("BOB_STAGE")
  })
})
