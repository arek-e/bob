/** Minimal runtime contracts used by the portable Core implementation. */
interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

interface R2ObjectBody {
  readonly body: ReadableStream
  readonly bodyUsed: boolean
  readonly key: string
  readonly etag: string
  readonly httpMetadata?: { readonly contentType?: string }
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

interface R2Bucket {
  delete(key: string): Promise<void>
  get(key: string): Promise<R2ObjectBody | null>
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string,
    options?: { readonly httpMetadata?: { readonly contentType?: string } }
  ): Promise<{ readonly etag?: string }>
}

interface Queue<Job = unknown> {
  send(job: Job, options?: { delaySeconds?: number }): Promise<void>
  sendBatch(messages: readonly { body: Job; delaySeconds?: number }[]): Promise<void>
}

interface DurableObjectId {
  toString(): string
}

interface DurableObjectStub extends Fetcher {
  readonly id: DurableObjectId
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
  jurisdiction(name: string): DurableObjectNamespace
}

interface DurableObjectStorage {
  delete(key: string): Promise<boolean>
  deleteAlarm(): Promise<void>
  getAlarm(): Promise<number | null>
  get<Value = unknown>(key: string): Promise<Value | undefined>
  put<Value>(key: string, value: Value): Promise<void>
  setAlarm(scheduledTime: Date | number): Promise<void>
  transaction<Value>(operation: (storage: DurableObjectStorage) => Promise<Value>): Promise<Value>
}

interface DurableObjectState {
  readonly id: DurableObjectId
  readonly storage: DurableObjectStorage
  blockConcurrencyWhile<Value>(operation: () => Promise<Value>): Promise<Value>
  waitUntil(promise: Promise<unknown>): void
}

interface DurableObject {}

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
