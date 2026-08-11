import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/solid-start/plugin/vite"
import { defineConfig } from "vite"
import viteSolid from "vite-plugin-solid"

const sourceDirectory = new URL("./src/", import.meta.url).pathname

const apiBase =
  process.env.PUBLIC_API_BASE_URL === undefined || process.env.PUBLIC_API_BASE_URL === "same-origin"
    ? ""
    : process.env.PUBLIC_API_BASE_URL

export default defineConfig({
  server: {
    port: 3000
  },
  resolve: {
    alias: {
      "~": sourceDirectory
    }
  },
  define: {
    __BOB_API_BASE_URL__: JSON.stringify(apiBase)
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
        prerender: {
          outputPath: "/index.html",
          crawlLinks: false,
          retryCount: 0
        }
      }
    }),
    viteSolid({ ssr: true })
  ]
})
