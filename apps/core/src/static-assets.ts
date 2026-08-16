import { readFile, stat } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"

const contentTypes: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
})

function safeAssetPath(root: string, pathname: string): string | undefined {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "")
  const target = resolve(root, relative)
  return target === root || target.startsWith(`${root}${sep}`) ? target : undefined
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

interface RuntimeFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export function makeFilesystemAssetFetcher(directory: string): RuntimeFetcher {
  const root = resolve(directory)
  return {
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405 })
      }
      const pathname = new URL(request.url).pathname
      const requested = safeAssetPath(root, pathname === "/" ? "/index.html" : pathname)
      const asset =
        requested !== undefined && (await regularFile(requested))
          ? requested
          : extname(pathname).length === 0
            ? resolve(root, "index.html")
            : undefined
      if (asset === undefined || !(await regularFile(asset))) {
        return new Response(null, { status: 404 })
      }
      const headers = new Headers({
        "cache-control": asset.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "content-type": contentTypes[extname(asset)] ?? "application/octet-stream",
        "x-content-type-options": "nosniff"
      })
      const body = request.method === "HEAD" ? null : Uint8Array.from(await readFile(asset)).buffer
      return new Response(body, { headers })
    }
  }
}
