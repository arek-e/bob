import {
  parseProductionDataQuery,
  ProductionDataInspector
} from "@bob/operations-types/production-data"
import { sql } from "drizzle-orm"
import { Effect } from "effect"

import type { HttpRouteContext } from "../../context.ts"

import { json } from "../../response.ts"

export async function handleInternalOperations(
  context: HttpRouteContext
): Promise<Response | undefined> {
  if (context.request.method === "GET" && context.url.pathname === "/internal/readiness") {
    const [result] = await Effect.runPromise(
      context.bindings.DB.execute<{ ready: number }>(sqlReadiness, "objects")
    )
    return json({ ready: result?.ready === 1 }, result?.ready === 1 ? 200 : 503)
  }

  if (
    context.request.method === "GET" &&
    context.url.pathname === "/internal/production-data/summary"
  ) {
    const query = parseProductionDataQuery({
      from: context.url.searchParams.get("from"),
      to: context.url.searchParams.get("to"),
      limit: context.url.searchParams.get("limit")
    })
    return json(
      await context.runTelemetry(
        Effect.flatMap(ProductionDataInspector, (inspector) => inspector.summary(query))
      )
    )
  }

  const workflowMatch = context.url.pathname.match(
    /^\/internal\/production-data\/workflow\/([^/]+)$/
  )
  if (context.request.method === "GET" && workflowMatch !== null) {
    const correlationId = decodeURIComponent(workflowMatch[1]!)
    const query = parseProductionDataQuery({ limit: context.url.searchParams.get("limit") })
    return json(
      await context.runTelemetry(
        Effect.flatMap(ProductionDataInspector, (inspector) =>
          inspector.workflow(correlationId, query.limit)
        )
      )
    )
  }

  return undefined
}

const sqlReadiness = sql`SELECT 1 AS ready`
