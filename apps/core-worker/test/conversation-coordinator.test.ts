import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"
import type { CoreDurableDependencies } from "../src/entrypoints/durable-objects.ts"

import { makeCoreTelemetryInvocation } from "../src/telemetry.ts"
import { testFixture } from "./test-fixture.ts"

const composeCore = vi.fn()
const processConversationTurn = vi.fn()
const flush = vi.fn(async () => undefined)
const dependencies = {
  composeCore,
  processConversationTurn,
  makeCoreTelemetryInvocation: vi.fn((bindings: CoreBindings) => ({
    ...makeCoreTelemetryInvocation(bindings),
    runPromise: <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect),
    flush
  }))
} satisfies CoreDurableDependencies

import { OwnerRunCoordinator } from "../src/entrypoints/durable-objects.ts"

const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db94"
const turnId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db96"
const quietUntil = "2026-08-12T10:00:01.500Z"
const claimExpiresAt = "2026-08-12T10:01:30.000Z"

function coordinatorState(initialAlarm: number | null = null) {
  const pending: Promise<void>[] = []
  let alarm = initialAlarm
  const getAlarm = vi.fn(async () => alarm)
  const setAlarm = vi.fn(async (scheduled: Date | number) => {
    alarm = scheduled instanceof Date ? scheduled.getTime() : scheduled
  })
  // SAFETY: This controlled test fixture matches the asserted contract used by this test.
  const state = testFixture<DurableObjectState>({
    storage: { getAlarm, setAlarm },
    blockConcurrencyWhile: vi.fn((operation: () => Promise<void>) => operation()),
    waitUntil: vi.fn((work: Promise<void>) => pending.push(work))
  })
  return {
    clearAlarm: () => {
      alarm = null
    },
    getAlarm,
    pending,
    setAlarm,
    state
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("owner conversation coordinator", () => {
  it("durably collects one inbound event before it starts an agent run", async () => {
    const turns = {
      offer: vi.fn(async () => ({
        turnId,
        revision: 1,
        status: "collecting" as const,
        quietUntil,
        appended: true
      }))
    }
    // SAFETY: This focused test double implements every platform member exercised by this test.
    composeCore.mockReturnValue(testFixture<CoreComposition>({ services: { turns } }))
    const { pending, setAlarm, state } = coordinatorState()
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    const response = await coordinator.fetch(
      new Request("https://coordinator.internal/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-correlation-id": correlationId
        },
        body: JSON.stringify({ eventId, correlationId })
      })
    )
    await Promise.all(pending)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ ok: true, turnId, revision: 1 })
    expect(turns.offer).toHaveBeenCalledWith(
      eventId,
      expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    )
    expect(setAlarm).toHaveBeenCalledWith(new Date(quietUntil))
    expect(processConversationTurn).not.toHaveBeenCalled()
  })

  it("preserves an earlier owner alarm when another channel offers a later deadline", async () => {
    const earlier = Date.parse("2026-08-12T10:00:01.000Z")
    const turns = {
      offer: vi.fn(async () => ({
        turnId,
        revision: 1,
        status: "collecting" as const,
        quietUntil,
        appended: true
      }))
    }
    // SAFETY: This focused test double implements every platform member exercised by this test.
    composeCore.mockReturnValue(testFixture<CoreComposition>({ services: { turns } }))
    const { pending, setAlarm, state } = coordinatorState(earlier)
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    const response = await coordinator.fetch(
      new Request("https://coordinator.internal/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, correlationId })
      })
    )
    await Promise.all(pending)

    expect(response.status).toBe(202)
    expect(setAlarm).not.toHaveBeenCalled()
  })

  it("requests safe agent steering only after the newer revision is durable", async () => {
    const activeRunId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db88"
    let offered = false
    const turns = {
      offer: vi.fn(async () => {
        offered = true
        return {
          turnId,
          revision: 2,
          status: "collecting" as const,
          quietUntil,
          appended: true,
          activeRunId
        }
      }),
      markSettling: vi.fn(async () => ({ claimExpiresAt }))
    }
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    composeCore.mockReturnValue(
      testFixture<CoreComposition>({
        config: {
          AGENT_URL: "https://agent.example.invalid",
          AGENT_ACCESS_CLIENT_ID: "client",
          AGENT_ACCESS_CLIENT_SECRET: "secret"
        },
        services: { turns }
      })
    )
    const steer = vi.fn(async () => {
      expect(offered).toBe(true)
      return Response.json({ status: "aborted_model" })
    })
    vi.stubGlobal("fetch", steer)
    const { pending, state } = coordinatorState()
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    const response = await coordinator.fetch(
      new Request("https://coordinator.internal/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-correlation-id": correlationId
        },
        body: JSON.stringify({ eventId, correlationId })
      })
    )
    await Promise.all(pending)

    expect(response.status).toBe(202)
    expect(steer).toHaveBeenCalledWith(
      "https://agent.example.invalid/v1/steer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ runId: activeRunId })
      })
    )
  })

  it("persists the settling gate before it asks the Agent to abort", async () => {
    const activeRunId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db87"
    let settling = false
    const markSettling = vi.fn(async () => {
      settling = true
      return { claimExpiresAt }
    })
    const turns = {
      offer: vi.fn(async () => ({
        turnId,
        revision: 2,
        status: "collecting" as const,
        quietUntil,
        appended: true,
        activeRunId
      })),
      markSettling
    }
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    composeCore.mockReturnValue(
      testFixture<CoreComposition>({
        config: {
          AGENT_URL: "https://agent.example.invalid",
          AGENT_ACCESS_CLIENT_ID: "client",
          AGENT_ACCESS_CLIENT_SECRET: "secret"
        },
        services: { turns }
      })
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        expect(settling).toBe(true)
        return Response.json({ status: "aborted_model" })
      })
    )
    const { pending, state } = coordinatorState()
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    await coordinator.fetch(
      new Request("https://coordinator.internal/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, correlationId })
      })
    )
    await Promise.all(pending)

    expect(markSettling).toHaveBeenCalledWith(turnId, 2, activeRunId)
  })

  it("holds the next revision while an active tool settles", async () => {
    const activeRunId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db88"
    const markSettling = vi.fn(async () => ({ claimExpiresAt }))
    const turns = {
      offer: vi.fn(async () => ({
        turnId,
        revision: 2,
        status: "collecting" as const,
        quietUntil,
        appended: true,
        activeRunId
      })),
      markSettling
    }
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    composeCore.mockReturnValue(
      testFixture<CoreComposition>({
        config: {
          AGENT_URL: "https://agent.example.invalid",
          AGENT_ACCESS_CLIENT_ID: "client",
          AGENT_ACCESS_CLIENT_SECRET: "secret"
        },
        services: { turns }
      })
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "queued" }))
    )
    const { pending, state } = coordinatorState()
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    await coordinator.fetch(
      new Request("https://coordinator.internal/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, correlationId })
      })
    )
    await Promise.all(pending)

    expect(markSettling).toHaveBeenCalledWith(turnId, 2, activeRunId)
  })

  it("holds the next revision when live steering is unavailable", async () => {
    const activeRunId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db89"
    const markSettling = vi.fn(async () => ({ claimExpiresAt }))
    const turns = {
      offer: vi.fn(async () => ({
        turnId,
        revision: 3,
        status: "collecting" as const,
        quietUntil,
        appended: true,
        activeRunId
      })),
      markSettling
    }
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    composeCore.mockReturnValue(
      testFixture<CoreComposition>({
        config: {
          AGENT_URL: "https://agent.example.invalid",
          AGENT_ACCESS_CLIENT_ID: "client",
          AGENT_ACCESS_CLIENT_SECRET: "secret"
        },
        services: { turns }
      })
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 }))
    )
    const { pending, state } = coordinatorState()
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    await coordinator.fetch(
      new Request("https://coordinator.internal/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, correlationId })
      })
    )
    await Promise.all(pending)

    expect(markSettling).toHaveBeenCalledWith(turnId, 3, activeRunId)
  })

  it("keeps the settling gate when the Agent reports an unknown run", async () => {
    const activeRunId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db86"
    const releaseSettling = vi.fn(async () => ({ ready: true }))
    const turns = {
      offer: vi.fn(async () => ({
        turnId,
        revision: 2,
        status: "collecting" as const,
        quietUntil,
        appended: true,
        activeRunId
      })),
      markSettling: vi.fn(async () => ({ claimExpiresAt })),
      releaseSettling
    }
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    composeCore.mockReturnValue(
      testFixture<CoreComposition>({
        config: {
          AGENT_URL: "https://agent.example.invalid",
          AGENT_ACCESS_CLIENT_ID: "client",
          AGENT_ACCESS_CLIENT_SECRET: "secret"
        },
        services: { turns }
      })
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "missing" }))
    )
    const { pending, state } = coordinatorState()
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    await coordinator.fetch(
      new Request("https://coordinator.internal/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, correlationId })
      })
    )
    await Promise.all(pending)

    expect(releaseSettling).not.toHaveBeenCalled()
  })

  it("runs the latest ready revision from the alarm", async () => {
    const snapshot = {
      turnId,
      ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db91",
      channelId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db92",
      revision: 2,
      claimExpiresAt,
      latest: {
        eventId,
        messageId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db93",
        text: "List",
        correlationId
      },
      messages: [
        {
          eventId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db97",
          messageId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db98",
          text: "Lost my reminders",
          ordinal: 1
        },
        {
          eventId,
          messageId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db93",
          text: "List",
          ordinal: 2
        }
      ]
    }
    const turns = {
      claimReady: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValue(undefined),
      nextWakeAt: vi.fn(async () => undefined)
    }
    // SAFETY: This focused test double implements every platform member exercised by this test.
    composeCore.mockReturnValue(testFixture<CoreComposition>({ services: { turns } }))
    processConversationTurn.mockResolvedValue(undefined)
    const { pending, state } = coordinatorState()
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    await coordinator.alarm()
    await Promise.all(pending)

    expect(turns.claimReady).toHaveBeenCalledTimes(2)
    expect(processConversationTurn).toHaveBeenCalledWith(
      snapshot,
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it("schedules the claimed revision expiry before processing and keeps it after rejection", async () => {
    const snapshot = {
      turnId,
      revision: 2,
      claimExpiresAt,
      latest: { eventId, text: "Latest correction" }
    }
    const turns = {
      claimReady: vi.fn(async () => snapshot),
      nextWakeAt: vi.fn(async () => undefined)
    }
    // SAFETY: This focused test double implements every platform member exercised by this test.
    composeCore.mockReturnValue(testFixture<CoreComposition>({ services: { turns } }))
    const { getAlarm, setAlarm, state } = coordinatorState()
    processConversationTurn.mockImplementation(async () => {
      expect(setAlarm).toHaveBeenCalledWith(new Date(claimExpiresAt))
      throw new Error("agent process rejected")
    })
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    await expect(coordinator.alarm()).rejects.toThrow("agent process rejected")

    await expect(getAlarm()).resolves.toBe(Date.parse(claimExpiresAt))
    expect(turns.nextWakeAt).not.toHaveBeenCalled()
  })

  it("drains ready channel turns serially for one owner", async () => {
    const first = { turnId, revision: 1, claimExpiresAt }
    const second = {
      turnId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db85",
      revision: 2,
      claimExpiresAt
    }
    const claimReady = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(undefined)
    const turns = { claimReady, nextWakeAt: vi.fn(async () => undefined) }
    // SAFETY: This focused test double implements every platform member exercised by this test.
    composeCore.mockReturnValue(testFixture<CoreComposition>({ services: { turns } }))
    let active = 0
    let maximumActive = 0
    const order: string[] = []
    processConversationTurn.mockImplementation(async (snapshot) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      order.push(snapshot.turnId)
      await Promise.resolve()
      active -= 1
    })
    const { state } = coordinatorState()
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    await coordinator.alarm()

    expect(order).toEqual([first.turnId, second.turnId])
    expect(maximumActive).toBe(1)
    expect(claimReady).toHaveBeenCalledTimes(3)
  })

  it("processes the latest revision when the settling recovery alarm fires", async () => {
    const recovered = {
      turnId,
      revision: 2,
      claimExpiresAt,
      latest: { eventId, text: "Latest correction" }
    }
    const turns = {
      claimReady: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(recovered)
        .mockResolvedValueOnce(undefined),
      nextWakeAt: vi.fn().mockResolvedValueOnce(claimExpiresAt).mockResolvedValue(undefined)
    }
    // SAFETY: This focused test double implements every platform member exercised by this test.
    composeCore.mockReturnValue(testFixture<CoreComposition>({ services: { turns } }))
    const { clearAlarm, setAlarm, state } = coordinatorState(Date.parse(quietUntil))
    clearAlarm()
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)
    processConversationTurn.mockResolvedValue(undefined)

    await coordinator.alarm()

    expect(turns.claimReady).toHaveBeenCalledOnce()
    expect(setAlarm).toHaveBeenLastCalledWith(new Date(claimExpiresAt))
    expect(processConversationTurn).not.toHaveBeenCalled()

    clearAlarm()
    await coordinator.alarm()

    expect(processConversationTurn).toHaveBeenCalledWith(
      recovered,
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it("turns a wake request into an immediate alarm without starting a second run", async () => {
    const claimReady = vi.fn(async () => undefined)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    composeCore.mockReturnValue(
      testFixture<CoreComposition>({
        services: { turns: { claimReady } }
      })
    )
    const { pending, setAlarm, state } = coordinatorState(Date.now() + 60_000)
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)
    const before = Date.now()

    const response = await coordinator.fetch(
      new Request("https://coordinator.internal/wake", { method: "POST" })
    )
    await Promise.all(pending)

    expect(response.status).toBe(200)
    expect(setAlarm).toHaveBeenCalledOnce()
    const scheduled = setAlarm.mock.calls[0]![0]
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    expect((scheduled as Date).getTime()).toBeGreaterThanOrEqual(before)
    expect(claimReady).not.toHaveBeenCalled()
    expect(processConversationTurn).not.toHaveBeenCalled()
  })

  it("schedules a reflection wake at its durable mutation deadline", async () => {
    const wakeAt = "2026-08-12T10:01:00.000Z"
    // SAFETY: This focused test double implements every platform member exercised by this test.
    composeCore.mockReturnValue(testFixture<CoreComposition>({ services: { turns: {} } }))
    const { pending, setAlarm, state } = coordinatorState(Date.parse(wakeAt) + 60_000)
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    const response = await coordinator.fetch(
      new Request(`https://coordinator.internal/wake?at=${encodeURIComponent(wakeAt)}`, {
        method: "POST"
      })
    )
    await Promise.all(pending)

    expect(response.status).toBe(200)
    expect(setAlarm).toHaveBeenCalledWith(new Date(wakeAt))
    expect(processConversationTurn).not.toHaveBeenCalled()
  })

  it("keeps an earlier alarm when a later reflection wake arrives", async () => {
    const earlier = Date.parse("2026-08-12T10:00:30.000Z")
    const later = "2026-08-12T10:01:00.000Z"
    // SAFETY: This focused test double implements every platform member exercised by this test.
    composeCore.mockReturnValue(testFixture<CoreComposition>({ services: { turns: {} } }))
    const { setAlarm, state } = coordinatorState(earlier)
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    const response = await coordinator.fetch(
      new Request(`https://coordinator.internal/wake?at=${encodeURIComponent(later)}`, {
        method: "POST"
      })
    )

    expect(response.status).toBe(200)
    expect(setAlarm).not.toHaveBeenCalled()
  })

  it("rejects an invalid reflection wake time", async () => {
    // SAFETY: This focused test double implements every platform member exercised by this test.
    composeCore.mockReturnValue(testFixture<CoreComposition>({ services: { turns: {} } }))
    const { setAlarm, state } = coordinatorState()
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const coordinator = new OwnerRunCoordinator(state, testFixture<CoreBindings>({}), dependencies)

    const response = await coordinator.fetch(
      new Request("https://coordinator.internal/wake?at=not-a-date", { method: "POST" })
    )

    expect(response.status).toBe(400)
    expect(setAlarm).not.toHaveBeenCalled()
  })
})
