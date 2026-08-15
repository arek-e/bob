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
          await store.assignInstance(event.route.id, instanceId, clock())
        }
        if ((await instances.lifecycle(instanceId)) !== "ready") {
          await store.release(event.id, "instance_not_ready", clock())
          return "retry"
        }
        await ingress.deliver(instanceId, event.payload)
        await store.complete(event.id, clock())
        return "delivered"
      } catch (error) {
        await store.release(
          event.id,
          error instanceof Error ? error.message : "delivery_failed",
          clock()
        )
        return "retry"
      }
    }
  }
}
