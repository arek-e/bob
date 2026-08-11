import { cp, mkdir, readFile, rm as removeEntry, unlink, writeFile } from "node:fs/promises"

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
const headers = await readFile(new URL("../_headers", import.meta.url), "utf8")
await writeFile(new URL("_headers", outputDirectory), headers)
