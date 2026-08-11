import { spawn } from "node:child_process"

import type { LiveEvaluationInput } from "./live.ts"

const MAX_STDOUT_BYTES = 64 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const PROCESS_TIMEOUT_MS = 32_000

export function createProcessAdapter(
  executable: string,
  args: readonly string[]
): (input: LiveEvaluationInput) => Promise<unknown> {
  return (input) =>
    new Promise<unknown>((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      })
      let stdout = ""
      let stderrBytes = 0
      let settled = false
      const finish = (
        result:
          | { readonly ok: true; readonly value: unknown }
          | { readonly ok: false; readonly code: string }
      ) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (result.ok) resolve(result.value)
        else reject(new Error(result.code))
      }
      const timer = setTimeout(() => {
        child.kill("SIGTERM")
        finish({ ok: false, code: "live_adapter_timeout" })
      }, PROCESS_TIMEOUT_MS)

      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk
        if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
          child.kill("SIGTERM")
          finish({ ok: false, code: "live_adapter_output_too_large" })
        }
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength
        if (stderrBytes > MAX_STDERR_BYTES) {
          child.kill("SIGTERM")
          finish({ ok: false, code: "live_adapter_error_too_large" })
        }
      })
      child.on("error", () => finish({ ok: false, code: "live_adapter_start_failed" }))
      child.on("close", (code) => {
        if (settled) return
        if (code !== 0) return finish({ ok: false, code: "live_adapter_failed" })
        try {
          finish({ ok: true, value: JSON.parse(stdout) as unknown })
        } catch {
          finish({ ok: false, code: "live_adapter_invalid_json" })
        }
      })
      child.stdin.on("error", () => finish({ ok: false, code: "live_adapter_input_failed" }))
      child.stdin.end(JSON.stringify(input))
    })
}
