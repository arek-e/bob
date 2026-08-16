export type GatewayFailureCode =
  | "access_denied"
  | "invalid_request"
  | "body_too_large"
  | "provider_unavailable"
  | "internal_error"

export class GatewayFailure extends Error {
  constructor(readonly code: GatewayFailureCode) {
    super(code)
    this.name = "GatewayFailure"
  }
}

export function gatewayFailure(code: GatewayFailureCode): GatewayFailure {
  return new GatewayFailure(code)
}
