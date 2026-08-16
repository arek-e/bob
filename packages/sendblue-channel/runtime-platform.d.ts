/** Minimal runtime contracts used by the portable Sendblue implementation. */
interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

interface Queue<Job = unknown> {
  send(job: Job, options?: { delaySeconds?: number }): Promise<void>
  sendBatch(messages: readonly { body: Job; delaySeconds?: number }[]): Promise<void>
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

interface Message<Body = unknown> {
  readonly body: Body
  ack(): void
  retry(options?: { delaySeconds?: number }): void
}

interface MessageBatch<Body = unknown> {
  readonly queue: string
  readonly messages: readonly Message<Body>[]
  ackAll(): void
  retryAll(options?: { delaySeconds?: number }): void
}

interface ScheduledController {
  readonly cron: string
  readonly scheduledTime: number
}

interface ExportedHandler<Environment = unknown> {
  fetch?(
    request: Request,
    env: Environment,
    context: ExecutionContext
  ): Response | Promise<Response>
  queue?(batch: MessageBatch, env: Environment, context: ExecutionContext): void | Promise<void>
  scheduled?(
    controller: ScheduledController,
    env: Environment,
    context: ExecutionContext
  ): void | Promise<void>
}
