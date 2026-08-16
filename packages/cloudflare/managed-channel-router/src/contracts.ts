import type { NormalizedInboundEvent } from "@bob/contracts/channel"

export interface ManagedRoute {
  readonly id: string
  readonly provisioningSubject: string
  readonly instanceId: string | null
}

export interface StagedChannelEvent {
  readonly id: string
  readonly claimVersion: number
  readonly route: ManagedRoute
  readonly payload: NormalizedInboundEvent
}

export interface ChannelRouteStore {
  registerRoute(senderLookup: string, provisioningSubject: string, now: Date): Promise<ManagedRoute>
  findRoute(senderLookup: string): Promise<ManagedRoute | null>
  stage(
    routeId: string,
    providerEventKey: string,
    payload: NormalizedInboundEvent,
    now: Date
  ): Promise<{ readonly eventId: string; readonly duplicate: boolean }>
  claim(eventId: string, now: Date, leaseMs: number): Promise<StagedChannelEvent | null>
  assignInstance(routeId: string, instanceId: string, now: Date): Promise<string>
  release(eventId: string, claimVersion: number, reason: string, now: Date): Promise<boolean>
  complete(eventId: string, claimVersion: number, now: Date): Promise<boolean>
}

export interface ManagedInstanceClient {
  provision(provisioningSubject: string, idempotencyKey: string): Promise<string>
  lifecycle(instanceId: string): Promise<string>
}

export interface InstanceIngress {
  deliver(instanceId: string, event: NormalizedInboundEvent): Promise<void>
}

export interface ChannelEventQueue {
  send(eventId: string): Promise<void>
}
