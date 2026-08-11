import { ToolResult, type ToolCommand } from "@bob/contracts/tools"
import { Context, Layer, Schema } from "effect"

export interface CoreToolClient {
  execute(command: ToolCommand): Promise<typeof ToolResult.Type>
}

export const CoreToolClient = Context.Service<CoreToolClient>("bob/CoreToolClient")

export function createCoreToolClient(options: {
  readonly coreUrl: string
  readonly accessClientId: string
  readonly accessClientSecret: string
  readonly fetch?: typeof fetch
}): CoreToolClient {
  const request = options.fetch ?? fetch
  return {
    async execute(command) {
      const response = await request(`${options.coreUrl}/internal/tools`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Access-Client-Id": options.accessClientId,
          "CF-Access-Client-Secret": options.accessClientSecret
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) throw new Error(`Core tool request failed: ${response.status}`)
      return Schema.decodeUnknownSync(ToolResult)(await response.json())
    }
  }
}

export function coreToolClientLayer(service: CoreToolClient) {
  return Layer.succeed(CoreToolClient, service)
}
