import { NormalizedInboundEvent } from "@bob/contracts/channel"
import { Schema } from "effect"
import { describe, expect, it, vi } from "vitest"

import type { ChannelRouteStore, ManagedRoute, StagedChannelEvent } from "../src/contracts.ts"

import { createManagedChannelRouter, UnknownManagedSender } from "../src/router.ts"

const event = Schema.decodeUnknownSync(NormalizedInboundEvent)({
  id: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
  accountId: "account",
  lineId: "line",
  messageHandle: "provider-1",
  senderE164: "+46700000000",
  destinationE164: "+46711111111",
  text: "hello",
  service: "imessage",
  isGroup: false,
  providerOptedOut: false,
  receivedAt: "2026-08-15T00:00:00.000Z",
  correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0"
})

const route: ManagedRoute = {
  id: "route-1",
  provisioningSubject: "subject_opaque_0001",
  instanceId: null
}

function storeFixture(currentRoute: ManagedRoute | null = route) {
  let activeRoute = currentRoute
  let staged: StagedChannelEvent | null = null
  let delivered = false
  const store: ChannelRouteStore = {
    registerRoute: async () => route,
    findRoute: async () => activeRoute,
    stage: async (_routeId, _key, payload) => {
      staged = { id: "event-1", route: activeRoute ?? route, payload }
      return { eventId: "event-1", duplicate: false }
    },
    claim: async () => (delivered ? null : staged),
    assignInstance: async (_routeId, instanceId) => {
      activeRoute = { ...route, instanceId }
      if (staged) staged = { ...staged, route: activeRoute }
    },
    release: async () => undefined,
    complete: async () => {
      delivered = true
    }
  }
  return store
}

describe("Managed Channel Router", () => {
  it("rejects an unknown sender without provisioning", async () => {
    const provision = vi.fn()
    const queue = vi.fn()
    const router = createManagedChannelRouter(
      storeFixture(null),
      { provision, lifecycle: vi.fn() },
      { deliver: vi.fn() },
      { send: queue }
    )

    await expect(router.accept("unknown", "provider-1", event)).rejects.toBeInstanceOf(
      UnknownManagedSender
    )
    expect(provision).not.toHaveBeenCalled()
    expect(queue).not.toHaveBeenCalled()
  })

  it("holds the first event while the Instance starts", async () => {
    const store = storeFixture()
    const provision = vi.fn().mockResolvedValue("instance-1")
    const lifecycle = vi.fn().mockResolvedValueOnce("provisioning").mockResolvedValueOnce("ready")
    const deliver = vi.fn().mockResolvedValue(undefined)
    const queue = vi.fn().mockResolvedValue(undefined)
    const router = createManagedChannelRouter(
      store,
      { provision, lifecycle },
      { deliver },
      { send: queue }
    )

    await expect(router.accept("known", "provider-1", event)).resolves.toEqual({
      eventId: "event-1",
      duplicate: false
    })
    await expect(router.deliver("event-1")).resolves.toBe("retry")
    expect(deliver).not.toHaveBeenCalled()
    await expect(router.deliver("event-1")).resolves.toBe("delivered")

    expect(provision).toHaveBeenCalledOnce()
    expect(provision).toHaveBeenCalledWith("subject_opaque_0001", "channel-route:route-1")
    expect(JSON.stringify(provision.mock.calls)).not.toContain(event.senderE164)
    expect(JSON.stringify(provision.mock.calls)).not.toContain(event.text)
    expect(deliver).toHaveBeenCalledWith("instance-1", event)
  })

  it("does not deliver a completed staged event twice", async () => {
    const store = storeFixture({ ...route, instanceId: "instance-1" })
    const deliver = vi.fn().mockResolvedValue(undefined)
    const router = createManagedChannelRouter(
      store,
      { provision: vi.fn(), lifecycle: vi.fn().mockResolvedValue("ready") },
      { deliver },
      { send: vi.fn().mockResolvedValue(undefined) }
    )

    await router.accept("known", "provider-1", event)
    await expect(router.deliver("event-1")).resolves.toBe("delivered")
    await expect(router.deliver("event-1")).resolves.toBe("ignored")
    expect(deliver).toHaveBeenCalledOnce()
  })
})
