import { readdir, readFile } from "node:fs/promises"

async function javascriptFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name, directory)
    if (entry.isDirectory()) {
      files.push(...(await javascriptFiles(new URL(`${entry.name}/`, directory))))
    } else if (entry.name.endsWith(".js")) {
      files.push(path)
    }
  }
  return files
}

const assetDirectory = new URL("../apps/ui/dist/assets/", import.meta.url)
const [scripts, headers] = await Promise.all([
  Promise.all((await javascriptFiles(assetDirectory)).map((file) => readFile(file, "utf8"))),
  readFile(new URL("../apps/ui/dist/_headers", import.meta.url), "utf8")
])
const script = scripts.join("\n")

const forbiddenNames = [
  "DATA_KEK",
  "SENDBLUE_API",
  "SENDBLUE_WEBHOOK",
  "ACCESS_CLIENT_SECRET",
  "CLOUDFLARE_API_TOKEN",
  "OPENAI_API_KEY",
  "PI_AUTH"
]

for (const name of forbiddenNames) {
  if (script.includes(name))
    throw new Error(`Browser bundle contains forbidden configuration: ${name}`)
}

for (const required of [
  "Cache-Control: no-store",
  "Content-Security-Policy:",
  "Referrer-Policy: no-referrer",
  "frame-ancestors 'none'"
]) {
  if (!headers.includes(required)) throw new Error(`Browser headers omit: ${required}`)
}

console.log("UI bundle contains no forbidden configuration names and has privacy headers.")
