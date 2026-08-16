import type { NormalizedInboundEvent } from "@bob/contracts/channel"

import type {
  ChannelEventQueue,
  ChannelRouteStore,
  InstanceIngress,
  ManagedInstanceClient,
  ManagedRoute
} from "./contracts.ts"

export class UnknownManagedSender extends Error {}

export type DeliveryResult = "delivered" | "retry" | "ignored"

/** Holds authorized channel events until one managed Bob Instance is ready. */
export function createManagedChannelRouter(
  store: ChannelRouteStore,
  instances: ManagedInstanceClient,
  ingress: InstanceIngress,
  queue: ChannelEventQueue,
  options: { readonly clock?: () => Date; readonly leaseMs?: number } = {}
) {
  const clock = options.clock ?? (() => new Date())
  const leaseMs = options.leaseMs ?? 60_000
  return {
    register(senderLookup: string, provisioningSubject: string): Promise<ManagedRoute> {
      return store.registerRoute(senderLookup, provisioningSubject, clock())
    },
    async accept(
      senderLookup: string,
      providerEventKey: string,
      payload: NormalizedInboundEvent
    ): Promise<{ readonly eventId: string; readonly duplicate: boolean }> {
      const route = await store.findRoute(senderLookup)
      if (!route) throw new UnknownManagedSender("Sender is not authorized")
      const accepted = await store.stage(route.id, providerEventKey, payload, clock())
      await queue.send(accepted.eventId)
      return accepted
    },
    async deliver(eventId: string): Promise<DeliveryResult> {
      const event = await store.claim(eventId, clock(), leaseMs)
      if (!event) return "ignored"
      try {
        let instanceId = event.route.instanceId
        if (instanceId === null) {
          instanceId = await instances.provision(
            event.route.provisioningSubject,
            `channel-route:${event.route.id}`
          )
          instanceId = await store.assignInstance(event.route.id, instanceId, clock())
        }
        if ((await instances.lifecycle(instanceId)) !== "ready") {
          const released = await store.release(
            event.id,
            event.claimVersion,
            "instance_not_ready",
            clock()
          )
          return released ? "retry" : "ignored"
        }
        await ingress.deliver(instanceId, event.payload)
        const completed = await store.complete(event.id, event.claimVersion, clock())
        return completed ? "delivered" : "ignored"
      } catch (error) {
        const released = await store.release(
          event.id,
          event.claimVersion,
          error instanceof Error ? error.message : "delivery_failed",
          clock()
        )
        return released ? "retry" : "ignored"
      }
    }
  }
}
