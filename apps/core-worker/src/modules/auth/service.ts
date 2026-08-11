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

export async function ownerSession(request: Request, bindings: CoreBindings) {
  const session = await createOwnerAuth(bindings).api.getSession({ headers: request.headers })
  if (session?.user.email.trim().toLowerCase() !== bindings.OWNER_ACCESS_EMAIL.toLowerCase()) {
    return null
  }
  return session
}
