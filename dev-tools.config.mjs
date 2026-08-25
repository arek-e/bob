import { defineProject } from "@teampitch/dev-tools/config"

export default defineProject({
  schema: 1,
  id: "bob-runtime",
  instance: {
    basePort: 22_000,
    stride: 100,
    maximum: 49,
    allocation: "worktree",
    composeProject: "{project}-i{instance}"
  },
  ports: {
    ui: { offset: 0, protocol: "http" },
    core: { offset: 1, protocol: "http" },
    "smoke-core": { offset: 2, protocol: "http" },
    "smoke-agent": { offset: 3, protocol: "http" },
    "smoke-channel": { offset: 4, protocol: "http" }
  },
  env: {
    files: [".env", ".env.local", "apps/ui/.env"],
    variables: {
      BOB_CORE_HOST_PORT: "{port:core}",
      BOB_SMOKE_CORE_HOST_PORT: "{port:smoke-core}",
      BOB_SMOKE_AGENT_HOST_PORT: "{port:smoke-agent}",
      BOB_SMOKE_CHANNEL_HOST_PORT: "{port:smoke-channel}",
      BOB_UI_DEV_PORT: "{port:ui}",
      PUBLIC_API_BASE_URL: "http://bob-runtime-i{instance}-core.localhost:1355",
      UI_BASE_URL: "http://bob-runtime-i{instance}.localhost:1355"
    }
  },
  compose: {
    files: ["compose.yaml", "compose.dev.yaml"],
    services: ["core"],
    stop: true
  },
  profiles: {
    default: {
      ports: ["ui", "core"],
      develop: { program: "pnpm", args: ["--filter", "@bob/ui", "dev"] },
      routes: [
        { service: "ui", name: "bob-runtime-i{instance}" },
        { service: "core", name: "bob-runtime-i{instance}-core", healthPath: "/health" }
      ]
    }
  }
})
