import { copyFile, mkdir, rm } from "node:fs/promises"

import { build } from "esbuild"

const outputDirectory = new URL("../dist/", import.meta.url)
await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

const configuredBase = process.env.PUBLIC_API_BASE_URL
if (configuredBase !== "same-origin") {
  throw new Error("PUBLIC_API_BASE_URL must be same-origin")
}

await Promise.all([
  build({
    entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
    outfile: new URL("app.js", outputDirectory).pathname,
    bundle: true,
    format: "esm",
    minify: true,
    sourcemap: false,
    target: "es2023",
    define: { __BOB_API_BASE_URL__: JSON.stringify("") }
  }),
  build({
    entryPoints: [new URL("../src/styles.css", import.meta.url).pathname],
    outfile: new URL("app.css", outputDirectory).pathname,
    bundle: true,
    minify: true
  }),
  copyFile(new URL("../index.html", import.meta.url), new URL("index.html", outputDirectory)),
  copyFile(new URL("../_headers", import.meta.url), new URL("_headers", outputDirectory))
])
