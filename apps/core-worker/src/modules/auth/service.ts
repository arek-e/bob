import { betterAuth } from "better-auth"

import type { CoreBindings } from "../../bindings.ts"

const SESSION_SECONDS = 12 * 60 * 60

export interface OwnerAuthOptions {
  readonly allowSignUp?: boolean
}

export function createOwnerAuth(bindings: CoreBindings, options: OwnerAuthOptions = {}) {
  const ownerEmail = bindings.OWNER_ACCESS_EMAIL.trim().toLowerCase()
  const origin = new URL(bindings.UI_BASE_URL).origin

  return betterAuth({
    appName: "Bob",
    baseURL: origin,
    secret: bindings.BETTER_AUTH_SECRET,
    database: bindings.DB,
    trustedOrigins: [origin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !(options.allowSignUp ?? false),
      requireEmailVerification: false,
      minPasswordLength: 12,
      maxPasswordLength: 128
    },
    user: {
      modelName: "auth_user",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at"
      }
    },
    session: {
      modelName: "auth_session",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent"
      },
      expiresIn: SESSION_SECONDS,
      updateAge: 60 * 60,
      freshAge: 60 * 60
    },
    account: {
      modelName: "auth_account",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at"
      },
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
        updateUserInfoOnLink: false
      }
    },
    verification: {
      modelName: "auth_verification",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at"
      }
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (user.email.trim().toLowerCase() !== ownerEmail) return false
            return {
              data: {
                ...user,
                id: bindings.OWNER_ID,
                name: "Owner",
                email: ownerEmail,
                emailVerified: true
              }
            }
          }
        }
      }
    },
    rateLimit: {
      modelName: "auth_rate_limit",
      fields: { lastRequest: "last_request" },
      enabled: true,
      storage: "database",
      window: 60,
      max: 20,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 }
      }
    },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: "bob",
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"]
      },
      database: {
        generateId: "uuid"
      }
    },
    telemetry: { enabled: false }
  })
}

export type OwnerAuth = ReturnType<typeof createOwnerAuth>

export type OwnerSetupResult =
  | { readonly state: "created"; readonly response: Response }
  | { readonly state: "complete" }
  | { readonly state: "invalid_password" }
  | { readonly state: "failed"; readonly response: Response }

function passwordFrom(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("password" in input)) return undefined
  const password = (input as { password?: unknown }).password
  return typeof password === "string" && password.length >= 12 && password.length <= 128
    ? password
    : undefined
}

export function createOwnerAuthService(bindings: CoreBindings) {
  const auth = createOwnerAuth(bindings)
  const ownerEmail = bindings.OWNER_ACCESS_EMAIL.trim().toLowerCase()

  async function ownerLoginExists(): Promise<boolean> {
    const row = await bindings.DB.prepare("SELECT `id`, `email` FROM `auth_user` LIMIT 1").first<{
      id: string
      email: string
    }>()
    if (row === null) return false
    if (row.id !== bindings.OWNER_ID || row.email.trim().toLowerCase() !== ownerEmail) {
      throw new Error("Better Auth contains an unexpected owner account")
    }
    return true
  }

  return {
    handle(request: Request): Promise<Response> {
      return auth.handler(request)
    },

    ownerLoginExists,

    async session(request: Request) {
      const session = await auth.api.getSession({ headers: request.headers })
      return session?.user.email.trim().toLowerCase() === ownerEmail ? session : null
    },

    async setup(request: Request, input: unknown): Promise<OwnerSetupResult> {
      const password = passwordFrom(input)
      if (password === undefined) return { state: "invalid_password" }
      if (await ownerLoginExists()) return { state: "complete" }

      const headers = new Headers(request.headers)
      headers.delete("content-length")
      headers.set("content-type", "application/json")
      const signupRequest = new Request(new URL("/api/auth/sign-up/email", request.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Owner", email: ownerEmail, password })
      })
      const response = await createOwnerAuth(bindings, { allowSignUp: true }).handler(signupRequest)
      if (response.ok) return { state: "created", response }
      if (await ownerLoginExists()) return { state: "complete" }
      return { state: "failed", response }
    }
  }
}

export type OwnerAuthService = ReturnType<typeof createOwnerAuthService>
