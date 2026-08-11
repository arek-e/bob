import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const rootDirectory = fileURLToPath(new URL("../dist/", import.meta.url))
const port = Number(process.env.BOB_UI_PORT ?? 4173)
const host = process.env.BOB_UI_HOST ?? "127.0.0.1"
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" })
    response.end()
    return
  }

  let requestPath
  try {
    requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
  } catch {
    response.writeHead(400)
    response.end("Bad request")
    return
  }

  let filePath = join(rootDirectory, requestPath === "/" ? "index.html" : requestPath.slice(1))
  const relativePath = relative(rootDirectory, filePath)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    response.writeHead(403)
    response.end("Forbidden")
    return
  }

  try {
    const fileStat = await stat(filePath)
    if (fileStat.isDirectory()) filePath = join(filePath, "index.html")
  } catch {
    if (extname(requestPath)) {
      response.writeHead(404)
      response.end("Not found")
      return
    }
    filePath = join(rootDirectory, "index.html")
  }

  try {
    const body = await readFile(filePath)
    response.writeHead(200, {
      "Content-Length": body.byteLength,
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream"
    })
    if (request.method === "HEAD") response.end()
    else response.end(body)
  } catch {
    response.writeHead(404)
    response.end("Not found")
  }
})

server.listen(port, host, () => {
  console.log(`Bob UI preview: http://${host}:${port}`)
})
