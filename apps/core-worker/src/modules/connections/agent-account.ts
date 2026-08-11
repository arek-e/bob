import {
  AgentAuthStatus,
  DeviceLoginEvent,
  DeviceLoginState,
  type AgentAuthStatus as AgentAuthStatusValue,
  type DeviceLoginEvent as DeviceLoginEventValue,
  type DeviceLoginState as DeviceLoginStateValue
} from "@bob/contracts/agent"
import { Schema } from "effect"

export interface AgentAccountClient {
  getStatus(): Promise<AgentAuthStatusValue>
  getDeviceLoginStatus(): Promise<DeviceLoginStateValue>
  startDeviceLogin(): Promise<DeviceLoginEventValue>
}

export interface AgentAccountClientOptions {
  readonly url: string
  readonly accessClientId: string
  readonly accessClientSecret: string
  readonly fetch?: typeof fetch
}

export function makeAgentAccountClient(options: AgentAccountClientOptions): AgentAccountClient {
  const request = options.fetch ?? fetch
  const baseUrl = new URL(options.url)
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost") {
    throw new Error("Agent administration URL must use HTTPS")
  }
  const headers = {
    "CF-Access-Client-Id": options.accessClientId,
    "CF-Access-Client-Secret": options.accessClientSecret
  }

  async function call(path: string, init?: RequestInit) {
    const response = await request(new URL(path, baseUrl), {
      ...init,
      headers: { ...headers, ...init?.headers }
    })
    return { response, value: await response.json() }
  }

  return {
    async getStatus() {
      const { response, value } = await call("/v1/admin/auth/status")
      if (!response.ok) {
        throw new Error(`Agent administration request failed with status ${response.status}`)
      }
      return Schema.decodeUnknownSync(AgentAuthStatus)(value)
    },
    async getDeviceLoginStatus() {
      const { response, value } = await call("/v1/admin/auth/device-login")
      if (!response.ok) {
        throw new Error(`Agent administration request failed with status ${response.status}`)
      }
      return Schema.decodeUnknownSync(DeviceLoginState)(value)
    },
    async startDeviceLogin() {
      const { value } = await call("/v1/admin/auth/device-login", { method: "POST" })
      return Schema.decodeUnknownSync(DeviceLoginEvent)(value)
    }
  }
}
