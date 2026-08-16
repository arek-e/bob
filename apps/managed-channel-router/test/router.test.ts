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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function claimFenceStore() {
  let state: "staged" | "processing" | "delivered" = "staged"
  let activeClaimVersion = 0
  let leaseUntil = 0
  const release = vi.fn(async (_eventId: string, claimVersion: number) => {
    if (state !== "processing" || claimVersion !== activeClaimVersion) return false
    state = "staged"
    return true
  })
  const complete = vi.fn(async (_eventId: string, claimVersion: number) => {
    if (state !== "processing" || claimVersion !== activeClaimVersion) return false
    state = "delivered"
    return true
  })
  const store: ChannelRouteStore = {
    registerRoute: async () => ({ ...route, instanceId: "instance-1" }),
    findRoute: async () => ({ ...route, instanceId: "instance-1" }),
    stage: async () => ({ eventId: "event-1", duplicate: false }),
    claim: async (eventId, now, leaseMs) => {
      if (state === "delivered") return null
      if (state === "processing" && now.getTime() < leaseUntil) return null
      state = "processing"
      activeClaimVersion += 1
      leaseUntil = now.getTime() + leaseMs
      return {
        id: eventId,
        claimVersion: activeClaimVersion,
        route: { ...route, instanceId: "instance-1" },
        payload: event
      }
    },
    assignInstance: async (_routeId, instanceId) => instanceId,
    release,
    complete
  }
  return { store, release, complete }
}

function storeFixture(currentRoute: ManagedRoute | null = route) {
  let activeRoute = currentRoute
  let staged: StagedChannelEvent | null = null
  let delivered = false
  let claimVersion = 0
  const store: ChannelRouteStore = {
    registerRoute: async () => route,
    findRoute: async () => activeRoute,
    stage: async (_routeId, _key, payload) => {
      staged = { id: "event-1", claimVersion: 0, route: activeRoute ?? route, payload }
      return { eventId: "event-1", duplicate: false }
    },
    claim: async () => {
      if (delivered || !staged) return null
      claimVersion += 1
      return { ...staged, claimVersion }
    },
    assignInstance: async (_routeId, instanceId) => {
      activeRoute = { ...route, instanceId }
      if (staged) staged = { ...staged, route: activeRoute }
      return instanceId
    },
    release: async () => true,
    complete: async () => {
      delivered = true
      return true
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

  it("uses the stored Instance when concurrent provisioning selects different candidates", async () => {
    let assignedInstanceId: string | null = null
    const assignInstance = vi.fn(async (_routeId: string, candidateInstanceId: string) => {
      assignedInstanceId ??= candidateInstanceId
      return assignedInstanceId
    })
    const store: ChannelRouteStore = {
      registerRoute: async () => route,
      findRoute: async () => route,
      stage: async () => ({ eventId: "unused", duplicate: false }),
      claim: async (eventId) => ({ id: eventId, claimVersion: 1, route, payload: event }),
      assignInstance,
      release: async () => true,
      complete: async () => true
    }
    const provision = vi
      .fn()
      .mockResolvedValueOnce("instance-1")
      .mockResolvedValueOnce("instance-2")
    const lifecycle = vi.fn().mockResolvedValue("ready")
    const deliver = vi.fn().mockResolvedValue(undefined)
    const router = createManagedChannelRouter(
      store,
      { provision, lifecycle },
      { deliver },
      { send: vi.fn().mockResolvedValue(undefined) }
    )

    await expect(
      Promise.all([router.deliver("event-1"), router.deliver("event-2")])
    ).resolves.toEqual(["delivered", "delivered"])

    expect(assignInstance).toHaveBeenCalledTimes(2)
    expect(lifecycle.mock.calls).toEqual([["instance-1"], ["instance-1"]])
    expect(deliver.mock.calls).toEqual([
      ["instance-1", event],
      ["instance-1", event]
    ])
  })

  it("does not let an expired claimant release a newer claim", async () => {
    let now = new Date("2026-08-15T00:00:00.000Z")
    const firstLifecycle = deferred<string>()
    const secondLifecycle = deferred<string>()
    const lifecycle = vi
      .fn()
      .mockReturnValueOnce(firstLifecycle.promise)
      .mockReturnValueOnce(secondLifecycle.promise)
    const { store, release, complete } = claimFenceStore()
    const router = createManagedChannelRouter(
      store,
      { provision: vi.fn(), lifecycle },
      { deliver: vi.fn().mockResolvedValue(undefined) },
      { send: vi.fn().mockResolvedValue(undefined) },
      { clock: () => now, leaseMs: 1_000 }
    )

    const firstDelivery = router.deliver("event-1")
    await vi.waitFor(() => expect(lifecycle).toHaveBeenCalledTimes(1))
    now = new Date("2026-08-15T00:00:02.000Z")
    const secondDelivery = router.deliver("event-1")
    await vi.waitFor(() => expect(lifecycle).toHaveBeenCalledTimes(2))

    firstLifecycle.resolve("provisioning")
    await expect(firstDelivery).resolves.toBe("ignored")
    expect(release).toHaveBeenCalledWith(
      "event-1",
      1,
      "instance_not_ready",
      new Date("2026-08-15T00:00:02.000Z")
    )

    secondLifecycle.resolve("ready")
    await expect(secondDelivery).resolves.toBe("delivered")
    expect(complete).toHaveBeenCalledWith("event-1", 2, new Date("2026-08-15T00:00:02.000Z"))
  })

  it("does not let an expired claimant complete a newer claim", async () => {
    let now = new Date("2026-08-15T00:00:00.000Z")
    const firstIngress = deferred<void>()
    const secondIngress = deferred<void>()
    const deliver = vi
      .fn()
      .mockReturnValueOnce(firstIngress.promise)
      .mockReturnValueOnce(secondIngress.promise)
    const { store, complete } = claimFenceStore()
    const router = createManagedChannelRouter(
      store,
      { provision: vi.fn(), lifecycle: vi.fn().mockResolvedValue("ready") },
      { deliver },
      { send: vi.fn().mockResolvedValue(undefined) },
      { clock: () => now, leaseMs: 1_000 }
    )

    const firstDelivery = router.deliver("event-1")
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    now = new Date("2026-08-15T00:00:02.000Z")
    const secondDelivery = router.deliver("event-1")
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))

    firstIngress.resolve()
    await expect(firstDelivery).resolves.toBe("ignored")
    secondIngress.resolve()
    await expect(secondDelivery).resolves.toBe("delivered")
    expect(complete.mock.calls.map((call) => call[1])).toEqual([1, 2])
  })
})
