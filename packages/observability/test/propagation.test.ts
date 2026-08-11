import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  externalParentFromTraceparent,
  formatTraceparent,
  injectCurrentTraceparent,
  injectTraceparent,
  parseTraceparent
} from "../src/propagation.ts"

describe("W3C trace propagation", () => {
  it("round-trips one sampled context through an Effect external parent", async () => {
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    const parsed = parseTraceparent(header)
    expect(parsed).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true
    })

    const parent = externalParentFromTraceparent(header)
    expect(parent).toMatchObject({
      _tag: "ExternalSpan",
      traceId: parsed?.traceId,
      spanId: parsed?.spanId,
      sampled: true
    })

    const direct = injectTraceparent({ "x-request-id": "safe" }, parent!)
    expect(direct.get("traceparent")).toBe(header)
    expect(direct.get("x-request-id")).toBe("safe")
    expect(formatTraceparent(parent!)).toBe(header)

    const injected = await Effect.runPromise(
      injectCurrentTraceparent().pipe(Effect.withParentSpan(parent!))
    )
    expect(injected.get("traceparent")).toBe(header)
  })

  it("rejects invalid identifiers and preserves an unsampled flag", () => {
    const invalid = [
      undefined,
      "",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-xy"
    ]
    for (const value of invalid) {
      expect(parseTraceparent(value)).toBeUndefined()
      expect(externalParentFromTraceparent(value)).toBeUndefined()
    }

    const parent = externalParentFromTraceparent(
      " 00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-00 "
    )
    expect(parent?.sampled).toBe(false)
    expect(formatTraceparent(parent!)).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"
    )
    expect(
      externalParentFromTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03")
        ?.sampled
    ).toBe(true)
  })
})
