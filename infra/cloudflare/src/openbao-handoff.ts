export interface RuntimeCredentials {
  readonly accessTeamDomain: string
  readonly coreUrl: string
  readonly runAudience: string
  readonly adminAudience: string
  readonly coreToAgentClientId: string
  readonly coreToAgentClientSecret: string
  readonly coreToAgentAdminClientId: string
  readonly coreToAgentAdminClientSecret: string
  readonly agentToCoreClientId: string
  readonly agentToCoreClientSecret: string
}

export interface HandoffIdentityInput {
  readonly baoAddress: string
  readonly jwtRole?: string | undefined
  readonly oidcRequestUrl?: string | undefined
  readonly oidcRequestToken?: string | undefined
  readonly deployToken?: string | undefined
}

export type HandoffIdentity =
  | {
      readonly kind: "github-oidc"
      readonly baoAddress: string
      readonly jwtRole: string
      readonly oidcRequestUrl: string
      readonly oidcRequestToken: string
    }
  | {
      readonly kind: "openbao-token"
      readonly baoAddress: string
      readonly deployToken: string
    }

interface JsonResponse {
  readonly value?: unknown
  readonly auth?: { readonly client_token?: unknown }
}

type HandoffOperation =
  | "GitHub workload identity request"
  | "handoff token revocation"
  | "runtime record write"
  | "workload login"

export class RuntimeCredentialHandoffError extends Error {
  readonly operation: HandoffOperation
  readonly status: number

  constructor(operation: HandoffOperation, status: number) {
    super(`OpenBao ${operation} failed with status ${status}`)
    this.name = "RuntimeCredentialHandoffError"
    this.operation = operation
    this.status = status
  }
}

export function safeHandoffFailure(error: unknown): Error {
  return error instanceof RuntimeCredentialHandoffError
    ? error
    : new Error("OpenBao runtime credential handoff failed")
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.length > 0
}

export function selectHandoffIdentity(input: HandoffIdentityInput): HandoffIdentity {
  const { jwtRole, oidcRequestToken, oidcRequestUrl } = input
  const oidcValues = [jwtRole, oidcRequestUrl, oidcRequestToken]
  const oidcCount = oidcValues.filter(present).length
  if (oidcCount > 0 && oidcCount < oidcValues.length) {
    throw new Error("The GitHub OIDC handoff identity is incomplete")
  }
  const hasOidc = oidcCount === oidcValues.length
  const hasDeployToken = present(input.deployToken)
  if (Number(hasOidc) + Number(hasDeployToken) !== 1) {
    throw new Error("Configure exactly one OpenBao handoff identity")
  }
  if (hasDeployToken) {
    return {
      kind: "openbao-token",
      baoAddress: input.baoAddress,
      deployToken: input.deployToken
    }
  }
  if (!present(jwtRole) || !present(oidcRequestUrl) || !present(oidcRequestToken)) {
    throw new Error("The GitHub OIDC handoff identity is incomplete")
  }
  return {
    kind: "github-oidc",
    baoAddress: input.baoAddress,
    jwtRole,
    oidcRequestUrl,
    oidcRequestToken
  }
}

async function responseJson(
  response: Response,
  operation: HandoffOperation
): Promise<JsonResponse> {
  if (!response.ok) throw new RuntimeCredentialHandoffError(operation, response.status)
  return (await response.json()) as JsonResponse
}

async function githubIdentity(
  identity: Extract<HandoffIdentity, { readonly kind: "github-oidc" }>,
  fetch: typeof globalThis.fetch
): Promise<string> {
  const request = new URL(identity.oidcRequestUrl)
  request.searchParams.set("audience", "openbao")
  const payload = await responseJson(
    await fetch(request, {
      headers: { authorization: `Bearer ${identity.oidcRequestToken}` }
    }),
    "GitHub workload identity request"
  )
  if (typeof payload.value !== "string" || payload.value.length === 0) {
    throw new Error("GitHub workload identity response is invalid")
  }
  return payload.value
}

async function openBaoToken(
  identity: Extract<HandoffIdentity, { readonly kind: "github-oidc" }>,
  jwt: string,
  fetch: typeof globalThis.fetch
): Promise<string> {
  const payload = await responseJson(
    await fetch(`${identity.baoAddress.replace(/\/$/u, "")}/v1/auth/jwt/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: identity.jwtRole, jwt })
    }),
    "workload login"
  )
  const token = payload.auth?.client_token
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("OpenBao workload login response is invalid")
  }
  return token
}

export async function syncRuntimeCredentials(
  input: RuntimeCredentials,
  identity: HandoffIdentity,
  fetch: typeof globalThis.fetch = globalThis.fetch
): Promise<{ readonly recordsWritten: 3 }> {
  const token =
    identity.kind === "openbao-token"
      ? identity.deployToken
      : await openBaoToken(identity, await githubIdentity(identity, fetch), fetch)
  const mount = "ops"
  const prefix = "apps/prod/bob"
  const records = [
    {
      path: `${prefix}/access/core-to-agent`,
      data: {
        AGENT_ACCESS_CLIENT_ID: input.coreToAgentClientId,
        AGENT_ACCESS_CLIENT_SECRET: input.coreToAgentClientSecret,
        RUN_ACCESS_AUDIENCE: input.runAudience,
        RUN_ACCESS_SUBJECT: input.coreToAgentClientId
      }
    },
    {
      path: `${prefix}/access/core-to-agent-admin`,
      data: {
        AGENT_ADMIN_ACCESS_CLIENT_ID: input.coreToAgentAdminClientId,
        AGENT_ADMIN_ACCESS_CLIENT_SECRET: input.coreToAgentAdminClientSecret,
        ADMIN_ACCESS_AUDIENCE: input.adminAudience,
        ADMIN_ACCESS_SUBJECT: input.coreToAgentAdminClientId
      }
    },
    {
      path: `${prefix}/access/agent-to-core`,
      data: {
        CORE_ACCESS_CLIENT_ID: input.agentToCoreClientId,
        CORE_ACCESS_CLIENT_SECRET: input.agentToCoreClientSecret,
        CORE_URL: input.coreUrl,
        ACCESS_TEAM_DOMAIN: input.accessTeamDomain
      }
    }
  ] as const
  let writeFailure: unknown
  try {
    for (const record of records) {
      const response = await fetch(
        `${identity.baoAddress.replace(/\/$/u, "")}/v1/${mount}/data/${record.path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vault-token": token
          },
          body: JSON.stringify({ data: record.data })
        }
      )
      if (!response.ok) {
        throw new RuntimeCredentialHandoffError("runtime record write", response.status)
      }
    }
  } catch (error) {
    writeFailure = error
  }
  const revocation = await fetch(
    `${identity.baoAddress.replace(/\/$/u, "")}/v1/auth/token/revoke-self`,
    {
      method: "POST",
      headers: { "x-vault-token": token }
    }
  )
  if (!revocation.ok) {
    throw new RuntimeCredentialHandoffError("handoff token revocation", revocation.status)
  }
  if (writeFailure !== undefined) throw writeFailure
  return { recordsWritten: 3 }
}
