import { NormalizedInboundEvent } from "@bob/contracts/channel"
import { Schema } from "effect"

import type { ChannelRouteStore, ManagedRoute, StagedChannelEvent } from "./contracts.ts"
import type { ProtectedStagedPayload } from "./payload-protection.ts"

import { createStagedPayloadProtection } from "./payload-protection.ts"

interface RouteRow {
  readonly id: string
  readonly provisioning_subject: string
  readonly instance_id: string | null
}

interface EventRow extends RouteRow {
  readonly event_id: string
  readonly route_id: string
  readonly provider_event_key: string
  readonly payload_ciphertext: string
  readonly payload_iv: string
  readonly payload_key_version: string
}

const mapRoute = (row: RouteRow): ManagedRoute => ({
  id: row.id,
  provisioningSubject: row.provisioning_subject,
  instanceId: row.instance_id
})

/** D1 Adapter for authorized routes and staged channel events. */
export function createD1ChannelRouteStore(
  database: D1Database,
  encodedPayloadKey: string,
  keyVersion: string
): ChannelRouteStore {
  const protection = createStagedPayloadProtection(encodedPayloadKey, keyVersion)
  return {
    async registerRoute(senderLookup, provisioningSubject, now) {
      const existing = await database
        .prepare(
          `SELECT id, provisioning_subject, instance_id
           FROM managed_channel_routes WHERE sender_lookup = ?`
        )
        .bind(senderLookup)
        .first<RouteRow>()
      if (existing) {
        if (existing.provisioning_subject !== provisioningSubject)
          throw new Error("Managed sender already has another Provisioning Subject")
        return mapRoute(existing)
      }
      const id = crypto.randomUUID()
      const timestamp = now.toISOString()
      await database
        .prepare(
          `INSERT INTO managed_channel_routes (
             id, sender_lookup, provisioning_subject, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(sender_lookup) DO NOTHING`
        )
        .bind(id, senderLookup, provisioningSubject, timestamp, timestamp)
        .run()
      const row = await database
        .prepare(
          `SELECT id, provisioning_subject, instance_id
           FROM managed_channel_routes WHERE sender_lookup = ?`
        )
        .bind(senderLookup)
        .first<RouteRow>()
      if (!row) throw new Error("Managed route was not stored")
      if (row.provisioning_subject !== provisioningSubject)
        throw new Error("Managed sender already has another Provisioning Subject")
      return mapRoute(row)
    },
    async findRoute(senderLookup) {
      const row = await database
        .prepare(
          `SELECT id, provisioning_subject, instance_id
           FROM managed_channel_routes WHERE sender_lookup = ?`
        )
        .bind(senderLookup)
        .first<RouteRow>()
      return row ? mapRoute(row) : null
    },
    async stage(routeId, providerEventKey, payload, now) {
      const id = crypto.randomUUID()
      const timestamp = now.toISOString()
      const protectedPayload = await protection.encrypt(
        routeId,
        providerEventKey,
        JSON.stringify(payload)
      )
      const result = await database
        .prepare(
          `INSERT OR IGNORE INTO staged_channel_events (
             id, route_id, provider_event_key, payload_ciphertext, payload_iv,
             payload_key_version, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?)`
        )
        .bind(
          id,
          routeId,
          providerEventKey,
          protectedPayload.ciphertext,
          protectedPayload.iv,
          protectedPayload.keyVersion,
          timestamp,
          timestamp
        )
        .run()
      if (result.meta.changes > 0) return { eventId: id, duplicate: false }
      const existing = await database
        .prepare("SELECT id FROM staged_channel_events WHERE provider_event_key = ?")
        .bind(providerEventKey)
        .first<{ readonly id: string }>()
      if (!existing) throw new Error("Staged event replay was not found")
      return { eventId: existing.id, duplicate: true }
    },
    async claim(eventId, now, leaseMs) {
      const timestamp = now.toISOString()
      const result = await database
        .prepare(
          `UPDATE staged_channel_events
           SET state = 'processing', lease_until = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND (
             state = 'staged' OR (state = 'processing' AND lease_until <= ?)
           )`
        )
        .bind(new Date(now.getTime() + leaseMs).toISOString(), timestamp, eventId, timestamp)
        .run()
      if (result.meta.changes === 0) return null
      const row = await database
        .prepare(
          `SELECT e.id AS event_id, e.route_id, e.provider_event_key,
                  e.payload_ciphertext, e.payload_iv, e.payload_key_version,
                  r.id, r.provisioning_subject, r.instance_id
           FROM staged_channel_events e
           JOIN managed_channel_routes r ON r.id = e.route_id
           WHERE e.id = ?`
        )
        .bind(eventId)
        .first<EventRow>()
      if (!row) throw new Error("Claimed channel event was not found")
      const plaintext = await protection.decrypt(row.route_id, row.provider_event_key, {
        ciphertext: row.payload_ciphertext,
        iv: row.payload_iv,
        keyVersion: row.payload_key_version
      } satisfies ProtectedStagedPayload)
      return {
        id: row.event_id,
        route: mapRoute(row),
        payload: Schema.decodeUnknownSync(NormalizedInboundEvent)(JSON.parse(plaintext))
      } satisfies StagedChannelEvent
    },
    async assignInstance(routeId, instanceId, now) {
      await database
        .prepare(
          `UPDATE managed_channel_routes SET instance_id = ?, updated_at = ?
           WHERE id = ? AND (instance_id IS NULL OR instance_id = ?)`
        )
        .bind(instanceId, now.toISOString(), routeId, instanceId)
        .run()
    },
    async release(eventId, reason, now) {
      await database
        .prepare(
          `UPDATE staged_channel_events
           SET state = 'staged', lease_until = NULL, last_failure = ?, updated_at = ?
           WHERE id = ? AND state = 'processing'`
        )
        .bind(reason.slice(0, 200), now.toISOString(), eventId)
        .run()
    },
    async complete(eventId, now) {
      await database
        .prepare(
          `UPDATE staged_channel_events
           SET state = 'delivered', lease_until = NULL, delivered_at = ?, updated_at = ?
           WHERE id = ? AND state = 'processing'`
        )
        .bind(now.toISOString(), now.toISOString(), eventId)
        .run()
    }
  }
}
