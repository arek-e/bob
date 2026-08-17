import type { CoreBindings } from "@bob/core-types/bindings"

import { betterAuth } from "better-auth"

const SESSION_SECONDS = 12 * 60 * 60

export interface OwnerAuthOptions {
  readonly allowSignUp?: boolean
  readonly allowedEmail?: string
  readonly ownerId?: string
}

export function createOwnerAuth(bindings: CoreBindings, options: OwnerAuthOptions = {}) {
  const allowedEmail = options.allowedEmail?.trim().toLowerCase()
  const origin = new URL(bindings.UI_BASE_URL).origin

  return betterAuth({
    appName: "Bob",
    baseURL: origin,
    secret: bindings.BETTER_AUTH_SECRET,
    database: bindings.AUTH_DATABASE,
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
            if (allowedEmail !== undefined && user.email.trim().toLowerCase() !== allowedEmail)
              return false
            return {
              data: {
                ...user,
                id: options.ownerId ?? user.id,
                name: "Owner",
                email: user.email.trim().toLowerCase(),
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
      useSecureCookies: origin.startsWith("https:"),
      cookiePrefix: "bob",
      ipAddress: {
        ipAddressHeaders: ["x-bob-client-address", "cf-connecting-ip"]
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
  return createOwnerAuth(bindings).api.getSession({ headers: request.headers })
}
