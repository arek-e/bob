import { pathToFileURL } from "node:url"

import { assertReleaseBundle, readReleaseBundle } from "./release-bundle.mjs"

const digestPattern = /^sha256:[0-9a-f]{64}$/u
const revisionPattern = /^[0-9a-f]{40}$/u

const required = (name, environment = process.env) => {
  const value = environment[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const requiredRuntimeImage = (images, name) => {
  const digest = images.get(name)
  if (!digest) throw new Error(`Coolify promotion needs the ${name} Runtime image`)
  return digest
}

export const releaseEnvironment = (bundle) => {
  const releaseBundle = assertReleaseBundle(bundle)
  if (!revisionPattern.test(releaseBundle.sourceRevision ?? "")) {
    throw new Error("Release source revision is invalid")
  }
  const images = new Map(releaseBundle.runtimeImages.map((image) => [image.name, image.digest]))
  const values = {
    BOB_RELEASE_SHA: releaseBundle.sourceRevision,
    BOB_AGENT_IMAGE_DIGEST: requiredRuntimeImage(images, "agent"),
    BOB_BACKUP_IMAGE_DIGEST: requiredRuntimeImage(images, "backup"),
    CLOUDFLARED_IMAGE_DIGEST: requiredRuntimeImage(images, "cloudflared"),
    BOB_OBSERVER_IMAGE_DIGEST: requiredRuntimeImage(images, "observer")
  }
  for (const [name, value] of Object.entries(values)) {
    if (name !== "BOB_RELEASE_SHA" && !digestPattern.test(value ?? "")) {
      throw new Error(`Release value ${name} is invalid`)
    }
  }
  return values
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const timeoutWithinDeadline = (deadline, maximumMs, now = Date.now) => {
  if (deadline === undefined) return maximumMs
  const remainingMs = deadline - now()
  if (remainingMs <= 0) throw new Error("Coolify release phase exceeded its deadline")
  return Math.min(maximumMs, remainingMs)
}

const readinessPassed = (readiness) =>
  readiness?.ready === true &&
  readiness.checks?.credentials === "ready" &&
  readiness.checks?.core === "ready" &&
  readiness.deploymentProfileId === "core"

export const createAgentReadinessVerifier = ({
  originUrl,
  clientId,
  clientSecret,
  fetchImplementation = fetch,
  nowImplementation = Date.now,
  options = {}
}) => {
  const url = new URL("/v1/admin/readiness", originUrl)
  const attempts = options.attempts ?? 12
  const intervalMs = options.intervalMs ?? 5_000
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("Agent readiness attempts must be a positive integer")
  }

  return async ({ deadline } = {}) => {
    let lastError
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const requestTimeoutMs = timeoutWithinDeadline(deadline, timeoutMs, nowImplementation)
        const response = await fetchImplementation(url, {
          headers: {
            authorization: `Bearer ${clientSecret}`,
            "cf-access-client-id": clientId,
            "cf-access-client-secret": clientSecret
          },
          redirect: "error",
          signal: AbortSignal.timeout(requestTimeoutMs)
        })
        if (!response.ok) {
          throw new Error(`Agent readiness request failed with status ${response.status}`)
        }
        if (!readinessPassed(await response.json())) {
          throw new Error("Agent readiness checks did not pass")
        }
        return
      } catch (error) {
        lastError = error
      }
      if (attempt + 1 < attempts) {
        await delay(timeoutWithinDeadline(deadline, intervalMs, nowImplementation))
      }
    }
    throw new Error("Agent readiness did not pass before its deadline", { cause: lastError })
  }
}

export class CoolifyReleaseClient {
  constructor({
    baseUrl,
    token,
    applicationId,
    fetchImplementation = fetch,
    nowImplementation = Date.now
  }) {
    this.baseUrl = new URL("/api/v1/", baseUrl)
    this.token = token
    this.applicationId = applicationId
    this.fetchImplementation = fetchImplementation
    this.nowImplementation = nowImplementation
  }

  async request(path, init = {}, options = {}) {
    const headers = new Headers(init.headers)
    headers.set("accept", "application/json")
    headers.set("authorization", `Bearer ${this.token}`)
    if (init.body) headers.set("content-type", "application/json")
    const response = await this.fetchImplementation(new URL(path, this.baseUrl), {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(
        timeoutWithinDeadline(options.deadline, 30_000, this.nowImplementation)
      )
    })
    if (!response.ok) throw new Error(`Coolify request failed with status ${response.status}`)
    return response.json()
  }

  async currentEnvironment(names, options = {}) {
    const variables = await this.request(`applications/${this.applicationId}/envs`, {}, options)
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

  async updateSourceRevision(sourceRevision, options = {}) {
    if (!revisionPattern.test(sourceRevision ?? "")) {
      throw new Error("Coolify source revision is invalid")
    }
    await this.request(
      `applications/${this.applicationId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ git_commit_sha: sourceRevision })
      },
      options
    )
  }

  async updateEnvironment(values, options = {}) {
    for (const [key, value] of Object.entries(values)) {
      await this.request(
        `applications/${this.applicationId}/envs`,
        {
          method: "PATCH",
          body: JSON.stringify({ key, value, is_preview: false, is_literal: false })
        },
        options
      )
    }
  }

  async deploy(options = {}) {
    const response = await this.request(
      `deploy?uuid=${encodeURIComponent(this.applicationId)}&force=false`,
      {},
      options
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
      const deployment = await this.request(`deployments/${deploymentId}`, {}, options)
      if (deployment.status === "finished") {
        if (deployment.commit !== sourceRevision) {
          throw new Error("Coolify deployed a different source revision")
        }
        return deployment
      }
      if (["failed", "cancelled", "cancelled-by-user"].includes(deployment.status)) {
        throw new Error(`Coolify deployment ended with status ${deployment.status}`)
      }
      await delay(timeoutWithinDeadline(options.deadline, intervalMs, this.nowImplementation))
    }
    throw new Error("Coolify deployment did not finish before its deadline")
  }
}

export const releaseToCoolify = async ({
  client,
  bundle,
  verifyReadiness,
  waitOptions,
  timingOptions = {}
}) => {
  const now = timingOptions.now ?? Date.now
  const releaseBudgetMs = timingOptions.releaseBudgetMs ?? 20 * 60_000
  const rollbackBudgetMs = timingOptions.rollbackBudgetMs ?? 20 * 60_000
  const desired = releaseEnvironment(bundle)
  const previous = await client.currentEnvironment(Object.keys(desired))
  const previousSourceRevision = previous.BOB_RELEASE_SHA
  if (!revisionPattern.test(previousSourceRevision ?? "")) {
    throw new Error("Prior release source revision is invalid")
  }
  try {
    const deadline = now() + releaseBudgetMs
    const phaseOptions = { deadline }
    await client.updateSourceRevision(bundle.sourceRevision, phaseOptions)
    await client.updateEnvironment(desired, phaseOptions)
    const deploymentId = await client.deploy(phaseOptions)
    await client.waitForDeployment(deploymentId, bundle.sourceRevision, {
      ...waitOptions,
      ...phaseOptions
    })
    await verifyReadiness({
      deploymentId,
      sourceRevision: bundle.sourceRevision,
      phase: "release",
      deadline
    })
    return { deploymentId, sourceRevision: bundle.sourceRevision }
  } catch (releaseError) {
    try {
      const deadline = now() + rollbackBudgetMs
      const phaseOptions = { deadline }
      await client.updateSourceRevision(previousSourceRevision, phaseOptions)
      await client.updateEnvironment(previous, phaseOptions)
      const rollbackId = await client.deploy(phaseOptions)
      await client.waitForDeployment(rollbackId, previousSourceRevision, {
        ...waitOptions,
        ...phaseOptions
      })
      await verifyReadiness({
        deploymentId: rollbackId,
        sourceRevision: previousSourceRevision,
        phase: "rollback",
        deadline
      })
    } catch (rollbackError) {
      throw new AggregateError(
        [releaseError, rollbackError],
        "Coolify release failed and its rollback did not become ready",
        { cause: releaseError }
      )
    }
    throw releaseError
  }
}

const main = async () => {
  const bundlePath = process.argv[2]
  if (!bundlePath) throw new Error("Usage: node scripts/coolify-release.mjs <release-bundle.json>")
  const bundle = await readReleaseBundle(bundlePath)
  const client = new CoolifyReleaseClient({
    baseUrl: required("COOLIFY_BASE_URL"),
    token: required("COOLIFY_API_TOKEN"),
    applicationId: required("COOLIFY_RUNTIME_APPLICATION_UUID")
  })
  const verifyReadiness = createAgentReadinessVerifier({
    originUrl: required("AGENT_ADMIN_ORIGIN_URL"),
    clientId: required("AGENT_ADMIN_ACCESS_CLIENT_ID"),
    clientSecret: required("AGENT_ADMIN_ACCESS_CLIENT_SECRET")
  })
  const result = await releaseToCoolify({ client, bundle, verifyReadiness })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
