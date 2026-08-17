export interface RuntimeFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export interface RuntimeQueue<Job> {
  send(job: Job, options?: { readonly delaySeconds?: number }): Promise<void>
  sendBatch(messages: readonly { body: Job; delaySeconds?: number }[]): Promise<void>
}

export interface RuntimeLifecycle {
  waitUntil(promise: Promise<unknown>): void
}
