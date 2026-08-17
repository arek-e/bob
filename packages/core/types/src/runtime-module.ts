import type { Effect, Schema } from "effect"

export type RouteJson = typeof Schema.Json.Type

export interface ConversationWorkflowInput {
  readonly ownerId: string
  readonly channelId: string
  readonly messageId: string
  readonly text: string
  readonly policyText: string
  readonly actionIdempotencyScope: string
  readonly now: Date
}

export interface ConversationWorkflowResult {
  readonly text?: string
  readonly reasonCode: string
  readonly feature: string
}

export interface PreparedConversationWorkflow {
  readonly reasonCode: string
  execute(): Promise<ConversationWorkflowResult>
}

export interface ConversationWorkflowModule {
  readonly id: string
  prepare(input: ConversationWorkflowInput): Promise<PreparedConversationWorkflow | undefined>
}

export interface OwnerRouteContext {
  readonly request: Request
  readonly url: URL
  readonly ownerId: string
  readJson(): Promise<RouteJson>
  idempotencyKey(): string
}

export interface OwnerRouteResult {
  readonly body: object | string | number | boolean | null
  readonly status?: number
}

export interface OwnerRouteModule {
  readonly id: string
  handle(context: OwnerRouteContext): Promise<OwnerRouteResult | undefined>
}

export interface ScheduledTaskContext {
  readonly correlationId: string
  readonly scheduledAt: Date
  readonly traceparent?: string
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
}

export interface ScheduledTaskModule {
  readonly id: string
  run(context: ScheduledTaskContext): Promise<void>
}

function assertUnique(kind: string, modules: readonly { readonly id: string }[]): void {
  const ids = modules.map((module) => module.id)
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${kind} Module ID`)
}

export function makeRuntimeModules(input: {
  readonly conversations?: readonly ConversationWorkflowModule[]
  readonly ownerRoutes?: readonly OwnerRouteModule[]
  readonly scheduledTasks?: readonly ScheduledTaskModule[]
}) {
  const conversations = Object.freeze([...(input.conversations ?? [])])
  const ownerRoutes = Object.freeze([...(input.ownerRoutes ?? [])])
  const scheduledTasks = Object.freeze([...(input.scheduledTasks ?? [])])
  assertUnique("conversation workflow", conversations)
  assertUnique("owner route", ownerRoutes)
  assertUnique("scheduled task", scheduledTasks)
  return Object.freeze({ conversations, ownerRoutes, scheduledTasks })
}

export type RuntimeModules = ReturnType<typeof makeRuntimeModules>
