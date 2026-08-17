export interface SendblueStatusCallbackContext {
  readonly outboxId: string
  readonly attemptId: string
  readonly correlationId: string
  readonly traceparent: string | null
}

export interface ReadSendblueStatusCallbackContext {
  readonly outboxId?: string
  readonly attemptId?: string
  readonly correlationId?: string
  readonly traceparent?: string
}
