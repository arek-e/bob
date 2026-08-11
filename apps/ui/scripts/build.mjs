import { cp, mkdir, readFile, rm as removeEntry, unlink, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"

const outputDirectory = new URL("../dist/", import.meta.url)
const clientDirectory = new URL("../dist/client/", import.meta.url)
const serverDirectory = new URL("../dist/server/", import.meta.url)
await mkdir(outputDirectory, { recursive: true })
await removeEntry(new URL("assets/", outputDirectory), { recursive: true, force: true })
await cp(clientDirectory, outputDirectory, { recursive: true, force: true })
await removeEntry(clientDirectory, { recursive: true, force: true })
await removeEntry(serverDirectory, { recursive: true, force: true })
for (const legacyAsset of ["app.js", "app.css"]) {
  await unlink(new URL(legacyAsset, outputDirectory)).catch(() => undefined)
}
const staticShell = await readFile(new URL("index.html", outputDirectory), "utf8")
const inlineScriptHashes = [...staticShell.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .filter((script) => script.trim().length > 0)
  .map((script) => `sha256-${createHash("sha256").update(script).digest("base64")}`)

const headers = await readFile(new URL("../_headers", import.meta.url), "utf8")
const contentSecurityPolicy = inlineScriptHashes.length
  ? headers.replace(
      "script-src 'self';",
      `script-src 'self' ${inlineScriptHashes.map((hash) => `'${hash}'`).join(" ")};`
    )
  : headers

await writeFile(new URL("_headers", outputDirectory), contentSecurityPolicy)
