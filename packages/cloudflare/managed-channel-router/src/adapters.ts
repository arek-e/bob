import type { NormalizedInboundEvent } from "@bob/contracts/channel"

import { Schema } from "effect"

import type { InstanceIngress, ManagedInstanceClient } from "./contracts.ts"

const ProvisionedInstanceResponse = Schema.Struct({
  instance: Schema.Struct({ id: Schema.String })
})
const InstanceResponse = Schema.Struct({ lifecycle: Schema.String })

export interface PlacementDefaults {
  readonly region: string
  readonly isolationClass: string
  readonly resourcePolicyId: string
  readonly releaseChannel: string
}

/** HTTP Adapter for the content-free managed Control Plane Interface. */
export function createControlPlaneClient(
  endpoint: string,
  token: string,
  placement: PlacementDefaults
): ManagedInstanceClient {
  const base = new URL(endpoint)
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost")
    throw new Error("CONTROL_PLANE_URL must use HTTPS")
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    headers.set("authorization", `Bearer ${token}`)
    if (init?.body !== undefined) headers.set("content-type", "application/json")
    const response = await fetch(new URL(path, base), {
      ...init,
      headers,
      redirect: "error"
    })
    if (!response.ok) throw new Error(`Control Plane returned status ${response.status}`)
    return response
  }
  return {
    async provision(provisioningSubject, idempotencyKey) {
      const response = await request("/v1/instances", {
        method: "POST",
        body: JSON.stringify({
          provisioningSubject,
          idempotencyKey,
          releaseChannel: placement.releaseChannel,
          region: placement.region,
          isolationClass: placement.isolationClass,
          resourcePolicyId: placement.resourcePolicyId
        })
      })
      const body = Schema.decodeUnknownSync(ProvisionedInstanceResponse)(await response.json())
      return body.instance.id
    },
    async lifecycle(instanceId) {
      const response = await request(`/v1/instances/${encodeURIComponent(instanceId)}`)
      const body = Schema.decodeUnknownSync(InstanceResponse)(await response.json())
      return body.lifecycle
    }
  }
}

/** Service binding Adapter for the managed Instance ingress gateway. */
export function createInstanceIngress(fetcher: Fetcher, callerToken: string): InstanceIngress {
  return {
    async deliver(instanceId: string, event: NormalizedInboundEvent) {
      const response = await fetcher.fetch("https://runtime-ingress.internal/internal/inbound", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-caller-token": callerToken,
          "x-bob-instance-id": instanceId,
          "x-bob-correlation-id": event.correlationId
        },
        body: JSON.stringify(event)
      })
      if (!response.ok) throw new Error(`Instance ingress returned status ${response.status}`)
    }
  }
}
