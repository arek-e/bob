import { Schema } from "effect"

export const ApiKeyCredential = Schema.Struct({
  type: Schema.Literal("api_key"),
  key: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
})

export type ApiKeyCredential = typeof ApiKeyCredential.Type

export const OAuthCredential = Schema.Struct({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optionalKey(Schema.String)
})

export type OAuthCredential = typeof OAuthCredential.Type

export const Credential = Schema.Union([ApiKeyCredential, OAuthCredential])

export type Credential = typeof Credential.Type

export const CredentialInfo = Schema.Struct({
  providerId: Schema.NonEmptyString,
  type: Schema.Literals(["api_key", "oauth"])
})

export type CredentialInfo = typeof CredentialInfo.Type

/** Cancellation options for the Promise-based Model SDK credential Adapter. */
export interface CredentialOperationOptions {
  readonly signal?: AbortSignal
}

/** Provider-neutral credential contract required by the Model SDK Adapter. */
export interface CredentialStore {
  read(providerId: string, options?: CredentialOperationOptions): Promise<Credential | undefined>
  list(options?: CredentialOperationOptions): Promise<readonly CredentialInfo[]>
  modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: CredentialOperationOptions
  ): Promise<Credential | undefined>
  delete(providerId: string, options?: CredentialOperationOptions): Promise<void>
}
