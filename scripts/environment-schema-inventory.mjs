import { spawnSync } from "node:child_process"
import { posix } from "node:path"

function normalizedPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "")
}

function isWorkspaceDirectory(directory) {
  const parts = directory.split("/")
  return (
    ((parts[0] === "apps" || parts[0] === "packages" || parts[0] === "tools") &&
      parts.length === 2) ||
    directory === "infra/cloudflare"
  )
}

export function environmentSchemaDirectories(trackedFiles) {
  const tracked = new Set(trackedFiles.map(normalizedPath))

  return [...tracked]
    .filter((path) => path.endsWith("/.env.schema"))
    .map((path) => posix.dirname(path))
    .filter(isWorkspaceDirectory)
    .filter((directory) => tracked.has(`${directory}/package.json`))
    .sort()
}

export function readTrackedFiles({ cwd = process.cwd(), spawn = spawnSync } = {}) {
  const result = spawn("git", ["ls-files", "-z"], { cwd, encoding: "utf8" })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error("git ls-files failed")

  return result.stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .map(normalizedPath)
}

export function discoverEnvironmentSchemaDirectories(options) {
  return environmentSchemaDirectories(readTrackedFiles(options))
}
