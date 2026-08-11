import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const COMMIT_PATTERN = /^[a-f0-9]{40}$/u
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const OVERLAY_PATH = "infra/kubernetes/overlays/prod/kustomization.yaml"

function uniqueMarker(lines, marker, label) {
  const indexes = lines.flatMap((line, index) => (line.trim() === marker ? [index] : []))
  if (indexes.length !== 1) {
    throw new Error(`The production overlay needs one ${label}`)
  }
  return indexes[0]
}

function imageDigest(lines, repository, label) {
  const markerIndex = uniqueMarker(lines, `newName: ${repository}`, `${label} repository`)
  const lineIndex = markerIndex + 1
  const line = lines[lineIndex]
  const match = line?.match(/^(\s*digest:\s*)(\S+)(\s*)$/u)
  if (match === null || match === undefined) {
    throw new Error(`The production overlay needs one ${label} digest`)
  }
  return {
    lineIndex,
    prefix: match[1],
    value: match[2],
    suffix: match[3]
  }
}

function releaseSha(lines) {
  const markerIndex = uniqueMarker(lines, "path: /data/BOB_RELEASE_SHA", "release SHA patch")
  const lineIndex = markerIndex + 1
  const line = lines[lineIndex]
  const match = line?.match(/^(\s*value:\s*)(\S+)(\s*)$/u)
  if (match === null || match === undefined) {
    throw new Error("The production overlay needs one release SHA value")
  }
  return {
    lineIndex,
    prefix: match[1],
    value: match[2],
    suffix: match[3]
  }
}

function releaseValues(overlay) {
  const lines = overlay.split("\n")
  return {
    lines,
    agent: imageDigest(lines, "ghcr.io/arek-e/bob-agent", "agent image"),
    backup: imageDigest(lines, "ghcr.io/arek-e/bob-data-backup", "backup image"),
    release: releaseSha(lines)
  }
}

function normalizedOverlay(values) {
  const lines = [...values.lines]
  lines[values.agent.lineIndex] = `${values.agent.prefix}<AGENT_DIGEST>${values.agent.suffix}`
  lines[values.backup.lineIndex] = `${values.backup.prefix}<BACKUP_DIGEST>${values.backup.suffix}`
  lines[values.release.lineIndex] = `${values.release.prefix}<SOURCE_SHA>${values.release.suffix}`
  return lines.join("\n")
}

export function assertReleaseGitOpsDelta({ sourceOverlay, gitopsOverlay, sourceSha }) {
  if (!COMMIT_PATTERN.test(sourceSha)) {
    throw new Error("The source SHA must be a full lowercase commit")
  }

  const source = releaseValues(sourceOverlay)
  const gitops = releaseValues(gitopsOverlay)
  if (!DIGEST_PATTERN.test(source.agent.value) || !DIGEST_PATTERN.test(gitops.agent.value)) {
    throw new Error("The agent image needs a full sha256 digest")
  }
  if (!DIGEST_PATTERN.test(source.backup.value) || !DIGEST_PATTERN.test(gitops.backup.value)) {
    throw new Error("The backup image needs a full sha256 digest")
  }
  if (!COMMIT_PATTERN.test(source.release.value) || !COMMIT_PATTERN.test(gitops.release.value)) {
    throw new Error("The release patch needs a full lowercase commit")
  }
  if (gitops.agent.value === source.agent.value) {
    throw new Error("The GitOps commit must change the agent digest")
  }
  if (gitops.backup.value === source.backup.value) {
    throw new Error("The GitOps commit must change the backup digest")
  }
  if (gitops.release.value !== sourceSha || gitops.release.value === source.release.value) {
    throw new Error("The GitOps release value must equal the source SHA")
  }
  if (normalizedOverlay(source) !== normalizedOverlay(gitops)) {
    throw new Error("The GitOps commit changes content outside the three release values")
  }

  return {
    agentDigest: gitops.agent.value,
    backupDigest: gitops.backup.value,
    releaseSha: gitops.release.value
  }
}

function gitFile(commit, path) {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
  } catch {
    throw new Error("Could not read the production overlay from the reviewed commit")
  }
}

export function verifyReleaseGitOpsDelta(sourceSha, gitopsSha) {
  if (!COMMIT_PATTERN.test(sourceSha) || !COMMIT_PATTERN.test(gitopsSha)) {
    throw new Error("Both release inputs must be full lowercase commits")
  }
  return assertReleaseGitOpsDelta({
    sourceOverlay: gitFile(sourceSha, OVERLAY_PATH),
    gitopsOverlay: gitFile(gitopsSha, OVERLAY_PATH),
    sourceSha
  })
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const sourceSha = process.argv[2]
  const gitopsSha = process.argv[3]
  if (sourceSha === undefined || gitopsSha === undefined) {
    throw new Error("Usage: verify-release-gitops-delta.mjs SOURCE_SHA GITOPS_SHA")
  }
  process.stdout.write(`${JSON.stringify(verifyReleaseGitOpsDelta(sourceSha, gitopsSha))}\n`)
}
