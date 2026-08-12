import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"

const harness = vi.hoisted(() => ({
  composeCore: vi.fn(),
  processConversationTurn: vi.fn(),
  flush: vi.fn(async () => undefined)
}))

vi.mock("../src/composition.ts", () => ({
  composeCore: harness.composeCore
}))

vi.mock("../src/process-inbound.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/process-inbound.ts")>()),
  processConversationTurn: harness.processConversationTurn
}))

vi.mock("../src/telemetry.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/telemetry.ts")>()
  return {
    ...actual,
    makeCoreTelemetryInvocation: vi.fn(() => ({
      layer: undefined,
      runPromise: <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect),
      flush: harness.flush
    }))
  }
})

import { OwnerRunCoordinator } from "../src/entrypoints/durable-objects.ts"

const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db94"
const turnId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db96"
const quietUntil = "2026-08-12T10:00:01.500Z"
const claimExpiresAt = "2026-08-12T10:01:30.000Z"

function coordinatorState(initialAlarm: number | null = null) {
  const pending: Promise<unknown>[] = []
  let alarm = initialAlarm
  const getAlarm = vi.fn(async () => alarm)
  const setAlarm = vi.fn(async (scheduled: Date | number) => {
    alarm = scheduled instanceof Date ? scheduled.getTime() : scheduled
  })
  const state = {
    storage: { getAlarm, setAlarm },
    blockConcurrencyWhile: vi.fn((operation: () => Promise<unknown>) => operation()),
    waitUntil: vi.fn((work: Promise<unknown>) => pending.push(work))
  } as unknown as DurableObjectState
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
    harness.composeCore.mockReturnValue({ services: { turns } } as unknown as CoreComposition)
    const { pending, setAlarm, state } = coordinatorState()
    const coordinator = new OwnerRunCoordinator(state, {} as CoreBindings)

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
    expect(harness.processConversationTurn).not.toHaveBeenCalled()
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
    harness.composeCore.mockReturnValue({ services: { turns } } as unknown as CoreComposition)
    const { pending, setAlarm, state } = coordinatorState(earlier)
    const coordinator = new OwnerRunCoordinator(state, {} as CoreBindings)

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
    harness.composeCore.mockReturnValue({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_ACCESS_CLIENT_ID: "client",
        AGENT_ACCESS_CLIENT_SECRET: "secret"
      },
      services: { turns }
    } as unknown as CoreComposition)
    const steer = vi.fn(async () => {
      expect(offered).toBe(true)
      return Response.json({ status: "aborted_model" })
    })
    vi.stubGlobal("fetch", steer)
    const { pending, state } = coordinatorState()
    const coordinator = new OwnerRunCoordinator(state, {} as CoreBindings)

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
    harness.composeCore.mockReturnValue({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_ACCESS_CLIENT_ID: "client",
        AGENT_ACCESS_CLIENT_SECRET: "secret"
      },
      services: { turns }
    } as unknown as CoreComposition)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        expect(settling).toBe(true)
        return Response.json({ status: "aborted_model" })
      })
    )
    const { pending, state } = coordinatorState()
    const coordinator = new OwnerRunCoordinator(state, {} as CoreBindings)

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
    harness.composeCore.mockReturnValue({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_ACCESS_CLIENT_ID: "client",
        AGENT_ACCESS_CLIENT_SECRET: "secret"
      },
      services: { turns }
    } as unknown as CoreComposition)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "queued" }))
    )
    const { pending, state } = coordinatorState()
    const coordinator = new OwnerRunCoordinator(state, {} as CoreBindings)

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
    harness.composeCore.mockReturnValue({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_ACCESS_CLIENT_ID: "client",
        AGENT_ACCESS_CLIENT_SECRET: "secret"
      },
      services: { turns }
    } as unknown as CoreComposition)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 }))
    )
    const { pending, state } = coordinatorState()
    const coordinator = new OwnerRunCoordinator(state, {} as CoreBindings)

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
    harness.composeCore.mockReturnValue({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_ACCESS_CLIENT_ID: "client",
        AGENT_ACCESS_CLIENT_SECRET: "secret"
      },
      services: { turns }
    } as unknown as CoreComposition)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "missing" }))
    )
    const { pending, state } = coordinatorState()
    const coordinator = new OwnerRunCoordinator(state, {} as CoreBindings)

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
    harness.composeCore.mockReturnValue({ services: { turns } } as unknown as CoreComposition)
    harness.processConversationTurn.mockResolvedValue(undefined)
    const { pending, state } = coordinatorState()
    const coordinator = new OwnerRunCoordinator(state, {} as CoreBindings)

    await coordinator.alarm()
    await Promise.all(pending)

    expect(turns.claimReady).toHaveBeenCalledTimes(2)
    expect(harness.processConversationTurn).toHaveBeenCalledWith(
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
    harness.composeCore.mockReturnValue({ services: { turns } } as unknown as CoreComposition)
    const { getAlarm, setAlarm, state } = coordinatorState()
    harness.processConversationTurn.mockImplementation(async () => {
      expect(setAlarm).toHaveBeenCalledWith(new Date(claimExpiresAt))
      throw new Error("agent process rejected")
    })
    const coordinator = new OwnerRunCoordinator(state, {} as CoreBindings)

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
    harness.composeCore.mockReturnValue({ services: { turns } } as unknown as CoreComposition)
    let active = 0
    let maximumActive = 0
    const order: string[] = []
    harness.processConversationTurn.mockImplementation(async (snapshot) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      order.push(snapshot.turnId)
      await Promise.resolve()
      active -= 1
    })
    const { state } = coordinatorState()
    const coordinator = new OwnerRunCoordinator(state, {} as CoreBindings)

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
    harness.composeCore.mockReturnValue({ services: { turns } } as unknown as CoreComposition)
    const { clearAlarm, setAlarm, state } = coordinatorState(Date.parse(quietUntil))
    clearAlarm()
    const coordinator = new OwnerRunCoordinator(state, {} as CoreBindings)
    harness.processConversationTurn.mockResolvedValue(undefined)

    await coordinator.alarm()

    expect(turns.claimReady).toHaveBeenCalledOnce()
    expect(setAlarm).toHaveBeenLastCalledWith(new Date(claimExpiresAt))
    expect(harness.processConversationTurn).not.toHaveBeenCalled()

    clearAlarm()
    await coordinator.alarm()

    expect(harness.processConversationTurn).toHaveBeenCalledWith(
      recovered,
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it("turns a wake request into an immediate alarm without starting a second run", async () => {
    const claimReady = vi.fn(async () => undefined)
    harness.composeCore.mockReturnValue({
      services: { turns: { claimReady } }
    } as unknown as CoreComposition)
    const { pending, setAlarm, state } = coordinatorState(Date.now() + 60_000)
    const coordinator = new OwnerRunCoordinator(state, {} as CoreBindings)
    const before = Date.now()

    const response = await coordinator.fetch(
      new Request("https://coordinator.internal/wake", { method: "POST" })
    )
    await Promise.all(pending)

    expect(response.status).toBe(200)
    expect(setAlarm).toHaveBeenCalledOnce()
    const scheduled = setAlarm.mock.calls[0]![0]
    expect((scheduled as Date).getTime()).toBeGreaterThanOrEqual(before)
    expect(claimReady).not.toHaveBeenCalled()
    expect(harness.processConversationTurn).not.toHaveBeenCalled()
  })
})
