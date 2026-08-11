import { readFile } from "node:fs/promises"

const [script, headers] = await Promise.all([
  readFile(new URL("../apps/ui/dist/app.js", import.meta.url), "utf8"),
  readFile(new URL("../apps/ui/dist/_headers", import.meta.url), "utf8")
])

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
