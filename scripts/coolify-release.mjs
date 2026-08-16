import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const digestPattern = /^sha256:[0-9a-f]{64}$/u
const revisionPattern = /^[0-9a-f]{40}$/u

const required = (name, environment = process.env) => {
  const value = environment[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

export const releaseEnvironment = (bundle) => {
  if (!revisionPattern.test(bundle.sourceRevision ?? "")) {
    throw new Error("Release source revision is invalid")
  }
  const images = new Map((bundle.runtimeImages ?? []).map((image) => [image.name, image.digest]))
  const values = {
    BOB_RELEASE_SHA: bundle.sourceRevision,
    BOB_AGENT_IMAGE_DIGEST: bundle.agentImageDigest,
    BOB_BACKUP_IMAGE_DIGEST: bundle.backupImageDigest,
    CLOUDFLARED_IMAGE_DIGEST: images.get("cloudflared"),
    BOB_OBSERVER_IMAGE_DIGEST: images.get("observer")
  }
  for (const [name, value] of Object.entries(values)) {
    if (name !== "BOB_RELEASE_SHA" && !digestPattern.test(value ?? "")) {
      throw new Error(`Release value ${name} is invalid`)
    }
  }
  return values
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export class CoolifyReleaseClient {
  constructor({ baseUrl, token, applicationId, fetchImplementation = fetch }) {
    this.baseUrl = new URL("/api/v1/", baseUrl)
    this.token = token
    this.applicationId = applicationId
    this.fetchImplementation = fetchImplementation
  }

  async request(path, init = {}) {
    const headers = new Headers(init.headers)
    headers.set("accept", "application/json")
    headers.set("authorization", `Bearer ${this.token}`)
    if (init.body) headers.set("content-type", "application/json")
    const response = await this.fetchImplementation(new URL(path, this.baseUrl), {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw new Error(`Coolify request failed with status ${response.status}`)
    return response.json()
  }

  async currentEnvironment(names) {
    const variables = await this.request(`applications/${this.applicationId}/envs`)
    return Object.fromEntries(
      names.map((name) => {
        const matches = variables.filter((item) => item.key === name && item.is_preview === false)
        if (matches.length !== 1) {
          throw new Error(`Coolify production variable ${name} is missing or duplicated`)
        }
        return [name, matches[0].value]
      })
    )
  }

  async currentSourceRevision(fallbackRevision) {
    const application = await this.request(`applications/${this.applicationId}`)
    const configuredRevision = application.git_commit_sha
    if (revisionPattern.test(configuredRevision ?? "")) return configuredRevision
    if (revisionPattern.test(fallbackRevision ?? "")) return fallbackRevision
    throw new Error("Coolify source revision is invalid")
  }

  async updateSourceRevision(sourceRevision) {
    if (!revisionPattern.test(sourceRevision ?? "")) {
      throw new Error("Coolify source revision is invalid")
    }
    await this.request(`applications/${this.applicationId}`, {
      method: "PATCH",
      body: JSON.stringify({ git_commit_sha: sourceRevision })
    })
  }

  async updateEnvironment(values) {
    for (const [key, value] of Object.entries(values)) {
      await this.request(`applications/${this.applicationId}/envs`, {
        method: "PATCH",
        body: JSON.stringify({ key, value, is_preview: false, is_literal: false })
      })
    }
  }

  async deploy() {
    const response = await this.request(
      `deploy?uuid=${encodeURIComponent(this.applicationId)}&force=false`
    )
    const deployment = response.deployments?.find(
      (item) => item.resource_uuid === this.applicationId
    )
    if (!deployment?.deployment_uuid) throw new Error("Coolify did not create a deployment")
    return deployment.deployment_uuid
  }

  async waitForDeployment(deploymentId, sourceRevision, options = {}) {
    const attempts = options.attempts ?? 80
    const intervalMs = options.intervalMs ?? 15_000
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const deployment = await this.request(`deployments/${deploymentId}`)
      if (deployment.status === "finished") {
        if (deployment.commit !== sourceRevision) {
          throw new Error("Coolify deployed a different source revision")
        }
        return deployment
      }
      if (["failed", "cancelled", "cancelled-by-user"].includes(deployment.status)) {
        throw new Error(`Coolify deployment ended with status ${deployment.status}`)
      }
      await delay(intervalMs)
    }
    throw new Error("Coolify deployment did not finish before its deadline")
  }
}

export const releaseToCoolify = async ({ client, bundle, waitOptions }) => {
  const desired = releaseEnvironment(bundle)
  const previous = await client.currentEnvironment(Object.keys(desired))
  const previousSourceRevision = await client.currentSourceRevision(previous.BOB_RELEASE_SHA)
  try {
    await client.updateSourceRevision(bundle.sourceRevision)
    await client.updateEnvironment(desired)
    const deploymentId = await client.deploy()
    await client.waitForDeployment(deploymentId, bundle.sourceRevision, waitOptions)
    return { deploymentId, sourceRevision: bundle.sourceRevision }
  } catch (error) {
    await client.updateSourceRevision(previousSourceRevision)
    await client.updateEnvironment(previous)
    const rollbackId = await client.deploy()
    await client.waitForDeployment(rollbackId, previousSourceRevision, waitOptions)
    throw error
  }
}

const main = async () => {
  const bundlePath = process.argv[2]
  if (!bundlePath) throw new Error("Usage: node scripts/coolify-release.mjs <release-bundle.json>")
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"))
  const client = new CoolifyReleaseClient({
    baseUrl: required("COOLIFY_BASE_URL"),
    token: required("COOLIFY_API_TOKEN"),
    applicationId: required("COOLIFY_RUNTIME_APPLICATION_UUID")
  })
  const result = await releaseToCoolify({ client, bundle })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
