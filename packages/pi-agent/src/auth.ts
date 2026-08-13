import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore
} from "@earendil-works/pi-ai"

import { Schema } from "effect"

const OAuthRecord = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  accountId: Schema.String
})

const AppRoleLoginResponse = Schema.Struct({
  auth: Schema.Struct({
    client_token: Schema.String,
    lease_duration: Schema.Number
  })
})

const KvReadResponse = Schema.Struct({
  data: Schema.Struct({
    data: OAuthRecord,
    metadata: Schema.Struct({ version: Schema.Number })
  })
})

export class CredentialConflictError extends Error {
  readonly code = "credential_conflict"
  constructor() {
    super("A concurrent credential update won")
    this.name = "CredentialConflictError"
  }
}

export interface OpenBaoCredentialStoreOptions {
  readonly address: string
  readonly appRoleRoleId: string
  readonly getAppRoleSecretId: (signal?: AbortSignal) => Promise<string>
  readonly mount?: string
  readonly authMount?: string
  readonly allowDelete?: boolean
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

interface VersionedCredential {
  readonly credential: Credential
  readonly version: number
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  const signals = [first, second].filter((signal): signal is AbortSignal => signal !== undefined)
  return signals.length === 0 ? undefined : AbortSignal.any(signals)
}

export class OpenBaoCredentialStore implements CredentialStore {
  private readonly request: typeof fetch
  private readonly mount: string
  private readonly authMount: string
  private readonly now: () => number
  private token?: { value: string; expiresAt: number }
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly options: OpenBaoCredentialStoreOptions) {
    this.request = options.fetch ?? fetch
    this.mount = options.mount ?? "ops"
    this.authMount = options.authMount ?? "approle"
    this.now = options.now ?? Date.now
  }

  private providerPath(providerId: string): string | undefined {
    if (providerId !== "openai-codex") return undefined
    return "apps/prod/bob/pi-auth/openai-codex"
  }

  private async withLock<A>(providerId: string, action: () => Promise<A>): Promise<A> {
    const previous = this.locks.get(providerId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const current = previous.then(() => gate)
    this.locks.set(providerId, current)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.locks.get(providerId) === current) this.locks.delete(providerId)
    }
  }

  private async vaultToken(signal?: AbortSignal): Promise<string> {
    if (this.token !== undefined && this.token.expiresAt > this.now() + 30_000)
      return this.token.value
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const secretId = await this.options.getAppRoleSecretId(signal)
      const requestSignal = combineSignals(signal, controller.signal)
      const response = await this.request(
        `${this.options.address}/v1/auth/${this.authMount}/login`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role_id: this.options.appRoleRoleId, secret_id: secretId }),
          ...(requestSignal === undefined ? {} : { signal: requestSignal })
        }
      )
      if (!response.ok) throw new Error(`OpenBao AppRole authentication failed: ${response.status}`)
      const login = Schema.decodeUnknownSync(AppRoleLoginResponse)(await response.json())
      this.token = {
        value: login.auth.client_token,
        expiresAt: this.now() + login.auth.lease_duration * 1_000
      }
      return this.token.value
    } finally {
      clearTimeout(timeout)
    }
  }

  private async readVersioned(
    providerId: string,
    options?: AuthOperationOptions
  ): Promise<VersionedCredential | undefined> {
    const path = this.providerPath(providerId)
    if (path === undefined) return undefined
    const response = await this.request(`${this.options.address}/v1/${this.mount}/data/${path}`, {
      headers: { "X-Vault-Token": await this.vaultToken(options?.signal) },
      ...(options?.signal === undefined ? {} : { signal: options.signal })
    })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`OpenBao credential read failed: ${response.status}`)
    const value = Schema.decodeUnknownSync(KvReadResponse)(await response.json())
    return { credential: value.data.data as Credential, version: value.data.metadata.version }
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return (await this.readVersioned(providerId, options))?.credential
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const credential = await this.read("openai-codex", options)
    return credential === undefined ? [] : [{ providerId: "openai-codex", type: credential.type }]
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions
  ): Promise<Credential | undefined> {
    const path = this.providerPath(providerId)
    if (path === undefined) return undefined
    return this.withLock(providerId, async () => {
      const current = await this.readVersioned(providerId, options)
      const next = await fn(current?.credential)
      if (next === undefined) return current?.credential
      const validated = Schema.decodeUnknownSync(OAuthRecord)(next)
      const response = await this.request(`${this.options.address}/v1/${this.mount}/data/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Vault-Token": await this.vaultToken(options?.signal)
        },
        body: JSON.stringify({ data: validated, options: { cas: current?.version ?? 0 } }),
        ...(options?.signal === undefined ? {} : { signal: options.signal })
      })
      if (response.status === 400 || response.status === 409) {
        await this.readVersioned(providerId, options)
        throw new CredentialConflictError()
      }
      if (!response.ok) throw new Error(`OpenBao credential write failed: ${response.status}`)
      return validated as Credential
    })
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (!this.options.allowDelete)
      throw new Error("Credential deletion requires administration policy")
    const path = this.providerPath(providerId)
    if (path === undefined) return
    await this.withLock(providerId, async () => {
      const response = await this.request(
        `${this.options.address}/v1/${this.mount}/metadata/${path}`,
        {
          method: "DELETE",
          headers: { "X-Vault-Token": await this.vaultToken(options?.signal) },
          ...(options?.signal === undefined ? {} : { signal: options.signal })
        }
      )
      if (!response.ok && response.status !== 404) {
        throw new Error(`OpenBao credential deletion failed: ${response.status}`)
      }
    })
  }
}
