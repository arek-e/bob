import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Output from "alchemy/Output"
import { retain } from "alchemy/RemovalPolicy"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

import type { CoercedEnvSchema } from "./environment.generated.ts"

import { validateAccessTokenRotation } from "./access-token-policy.ts"
import {
  safeHandoffFailure,
  selectHandoffIdentity,
  syncRuntimeCredentials
} from "./openbao-handoff.ts"

const PRODUCTION_STAGE = "prod" as const

export interface BobStackOptions {
  readonly config: Readonly<CoercedEnvSchema>
  readonly name?: string
  readonly providers: ReturnType<typeof Cloudflare.providers>
  readonly state: ReturnType<typeof Cloudflare.state> | ReturnType<typeof Alchemy.inMemoryState>
}

function requiredSendblue(value: string | undefined, field: string): string {
  if (value === undefined) throw new Error(`${field} is required when SENDBLUE_ENABLED is true`)
  return value
}

function requiredGeneratedSecret(
  value: Redacted.Redacted<string> | undefined,
  field: string
): Redacted.Redacted<string> {
  if (value === undefined) throw new Error(`${field} was not returned by Cloudflare`)
  return value
}

export function createBobStack(options: BobStackOptions) {
  const ENV = options.config
  validateAccessTokenRotation(ENV.ACCESS_SERVICE_TOKEN_ROTATE_BY)

  if (!ENV.RUNTIME_CREDENTIAL_HANDOFF_ENABLED) {
    throw new Error("Production plans require the reviewed OpenBao runtime credential handoff")
  }

  if (!ENV.ALCHEMY_PRODUCTION_STATE_APPROVED) {
    throw new Error("Production Alchemy state needs an approved privacy review")
  }
  const handoffIdentity = selectHandoffIdentity({
    baoAddress: ENV.BAO_ADDR,
    jwtRole: ENV.BAO_JWT_ROLE,
    oidcRequestUrl: ENV.ACTIONS_ID_TOKEN_REQUEST_URL,
    oidcRequestToken: ENV.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    deployToken: ENV.BAO_DEPLOY_TOKEN
  })

  const RuntimeCredentialHandoff = Alchemy.Action(
    "OpenBaoRuntimeCredentialHandoff",
    (input: {
      accessTeamDomain: string
      coreUrl: string
      runAudience: string
      adminAudience: string
      coreToAgentClientId: string
      coreToAgentClientSecret: Redacted.Redacted<string>
      coreToAgentAdminClientId: string
      coreToAgentAdminClientSecret: Redacted.Redacted<string>
      agentToCoreClientId: string
      agentToCoreClientSecret: Redacted.Redacted<string>
    }) =>
      Effect.tryPromise({
        try: () => {
          return syncRuntimeCredentials(
            {
              ...input,
              coreToAgentClientSecret: Redacted.value(input.coreToAgentClientSecret),
              coreToAgentAdminClientSecret: Redacted.value(input.coreToAgentAdminClientSecret),
              agentToCoreClientSecret: Redacted.value(input.agentToCoreClientSecret)
            },
            handoffIdentity
          )
        },
        catch: safeHandoffFailure
      })
  )

  return Alchemy.Stack(
    options.name ?? "bob",
    { providers: options.providers, state: options.state },
    Effect.gen(function* () {
      const domain = ENV.BOB_DOMAIN
      const coreWorkerName = ENV.CLOUDFLARE_CORE_WORKER_NAME
      const coreHost = `bob.${domain}`
      const agentHost = `bob-agent.${domain}`
      const agentAdminHost = `bob-agent-admin.${domain}`
      const otlpHost = `bob-otel.${domain}`
      const nangoHost = `nango.${domain}`
      const ingressHost = `bob-sendblue.${domain}`
      const egressHost = `bob-sendblue-egress.${domain}`
      const sendblueActive = ENV.SENDBLUE_ENABLED

      const database = yield* Cloudflare.D1.Database("Database", {
        name: `bob-${PRODUCTION_STAGE}`,
        jurisdiction: "eu",
        primaryLocationHint: "weur",
        migrationsDir: "../../apps/core-worker/migrations"
      }).pipe(retain(true))

      const privateObjects = yield* Cloudflare.R2.Bucket("PrivateObjects", {
        name: `bob-private-${PRODUCTION_STAGE}`,
        jurisdiction: "eu",
        locationHint: "weur"
      }).pipe(retain(true))

      yield* Cloudflare.R2.Bucket("BackupArchives", {
        name: `bob-backup-${PRODUCTION_STAGE}`,
        jurisdiction: "eu",
        locationHint: "weur",
        lifecycleRules: [
          {
            id: "expire-backups-after-180-days",
            deleteObjectsTransition: {
              condition: { type: "Age", maxAge: 15_552_000 }
            }
          }
        ]
      }).pipe(retain(true))

      yield* Cloudflare.R2.Bucket("NangoBackups", {
        name: `bob-nango-backup-${PRODUCTION_STAGE}`,
        jurisdiction: "eu",
        locationHint: "weur",
        lifecycleRules: [
          {
            id: "expire-backups-after-180-days",
            deleteObjectsTransition: {
              condition: { type: "Age", maxAge: 15_552_000 }
            }
          }
        ]
      }).pipe(retain(true))

      const inboundDeadLetter = yield* Cloudflare.Queues.Queue("InboundDeadLetter", {
        name: `bob-inbound-dead-letter-${PRODUCTION_STAGE}`
      }).pipe(retain(true))
      const inboundQueue = yield* Cloudflare.Queues.Queue("InboundQueue", {
        name: `bob-inbound-${PRODUCTION_STAGE}`
      }).pipe(retain(true))
      const outboundDeadLetter = yield* Cloudflare.Queues.Queue("OutboundDeadLetter", {
        name: `bob-outbound-dead-letter-${PRODUCTION_STAGE}`
      }).pipe(retain(true))
      const outboundQueue = yield* Cloudflare.Queues.Queue("OutboundQueue", {
        name: `bob-outbound-${PRODUCTION_STAGE}`
      }).pipe(retain(true))
      const deliveryResultDeadLetter = yield* Cloudflare.Queues.Queue("DeliveryResultDeadLetter", {
        name: `bob-delivery-result-dead-letter-${PRODUCTION_STAGE}`
      }).pipe(retain(true))
      const deliveryResultQueue = yield* Cloudflare.Queues.Queue("DeliveryResultQueue", {
        name: `bob-delivery-result-${PRODUCTION_STAGE}`
      }).pipe(retain(true))

      const ownerRunCoordinator = Cloudflare.DurableObject("OwnerRunCoordinator")
      const reminderClock = Cloudflare.DurableObject("ReminderClock")

      const coreToAgent = yield* Cloudflare.Access.ServiceToken("CoreToAgentRun", {
        name: `bob-core-to-agent-run-${PRODUCTION_STAGE}-v${ENV.ACCESS_SERVICE_TOKEN_ROTATION_VERSION}`,
        duration: "168h",
        clientSecretVersion: ENV.ACCESS_SERVICE_TOKEN_ROTATION_VERSION
      })
      const coreToAgentAdmin = yield* Cloudflare.Access.ServiceToken("CoreToAgentAdmin", {
        name: `bob-core-to-agent-admin-${PRODUCTION_STAGE}-v${ENV.ACCESS_SERVICE_TOKEN_ROTATION_VERSION}`,
        duration: "168h",
        clientSecretVersion: ENV.ACCESS_SERVICE_TOKEN_ROTATION_VERSION
      })
      const agentToCore = yield* Cloudflare.Access.ServiceToken("AgentToCore", {
        name: `bob-agent-to-core-${PRODUCTION_STAGE}-v${ENV.ACCESS_SERVICE_TOKEN_ROTATION_VERSION}`,
        duration: "168h",
        clientSecretVersion: ENV.ACCESS_SERVICE_TOKEN_ROTATION_VERSION
      })
      const workerToOtlp = yield* Cloudflare.Access.ServiceToken("WorkerToOtlp", {
        name: `bob-worker-to-otlp-${PRODUCTION_STAGE}-v${ENV.ACCESS_SERVICE_TOKEN_ROTATION_VERSION}`,
        duration: "168h",
        clientSecretVersion: ENV.ACCESS_SERVICE_TOKEN_ROTATION_VERSION
      })

      const agentServicePolicy = yield* Cloudflare.Access.Policy("AgentRunServicePolicy", {
        name: `bob-agent-run-service-${PRODUCTION_STAGE}`,
        decision: "non_identity",
        include: [{ serviceToken: { tokenId: coreToAgent.serviceTokenId } }]
      })
      const agentApplication = yield* Cloudflare.Access.Application("AgentRunApplication", {
        type: "self_hosted",
        name: `Bob agent run (${PRODUCTION_STAGE})`,
        domain: agentHost,
        sessionDuration: "1h",
        policies: [agentServicePolicy.policyId]
      })
      const agentAdminServicePolicy = yield* Cloudflare.Access.Policy("AgentAdminServicePolicy", {
        name: `bob-agent-admin-service-${PRODUCTION_STAGE}`,
        decision: "non_identity",
        include: [{ serviceToken: { tokenId: coreToAgentAdmin.serviceTokenId } }]
      })
      const agentAdminApplication = yield* Cloudflare.Access.Application("AgentAdminApplication", {
        type: "self_hosted",
        name: `Bob agent administration (${PRODUCTION_STAGE})`,
        domain: agentAdminHost,
        sessionDuration: "15m",
        policies: [agentAdminServicePolicy.policyId]
      })
      const workerOtlpServicePolicy = yield* Cloudflare.Access.Policy("WorkerOtlpServicePolicy", {
        name: `bob-worker-otlp-service-${PRODUCTION_STAGE}`,
        decision: "non_identity",
        include: [{ serviceToken: { tokenId: workerToOtlp.serviceTokenId } }]
      })
      const workerOtlpApplication = yield* Cloudflare.Access.Application("WorkerOtlpApplication", {
        type: "self_hosted",
        name: `Bob Worker OTLP (${PRODUCTION_STAGE})`,
        domain: otlpHost,
        sessionDuration: "1h",
        policies: [workerOtlpServicePolicy.policyId]
      })

      const ownerPolicy = yield* Cloudflare.Access.Policy("OwnerPolicy", {
        name: `bob-owner-${PRODUCTION_STAGE}`,
        decision: "allow",
        include: [{ email: { email: ENV.OWNER_ACCESS_EMAIL } }],
        sessionDuration: "12h"
      })
      const agentCorePolicy = yield* Cloudflare.Access.Policy("AgentCorePolicy", {
        name: `bob-agent-core-${PRODUCTION_STAGE}`,
        decision: "non_identity",
        include: [{ serviceToken: { tokenId: agentToCore.serviceTokenId } }]
      })
      const coreApplication = yield* Cloudflare.Access.Application("CoreApplication", {
        type: "self_hosted",
        name: `Bob internal (${PRODUCTION_STAGE})`,
        domain: `${coreHost}/internal`,
        sessionDuration: "1h",
        policies: [agentCorePolicy.policyId]
      })
      const setupApplication = yield* Cloudflare.Access.Application("OwnerSetupApplication", {
        type: "self_hosted",
        name: `Bob owner setup (${PRODUCTION_STAGE})`,
        domain: `${coreHost}/setup`,
        sessionDuration: "15m",
        policies: [ownerPolicy.policyId]
      })

      const ingressCallerSecret = yield* Alchemy.makeRandom("IngressCallerSecret")
      const egressCallerSecret = yield* Alchemy.makeRandom("EgressCallerSecret")

      const coreWorker = yield* Cloudflare.Worker("CoreWorker", {
        name: coreWorkerName,
        main: "../../apps/core-worker/src/index.ts",
        workersDev: false,
        domain: coreHost,
        compatibility: { date: "2026-08-10", flags: ["nodejs_compat"] },
        assets: {
          directory: "../../apps/ui/dist",
          notFoundHandling: "single-page-application",
          runWorkerFirst: ["/api/*", "/internal/*", "/setup/api", "/health"]
        },
        crons: ["* * * * *"],
        observability: {
          enabled: true,
          logs: { enabled: true, invocationLogs: true },
          traces: { enabled: true, headSamplingRate: 1, persist: true }
        },
        env: {
          DB: database,
          PRIVATE_OBJECTS: privateObjects,
          INBOUND_QUEUE: inboundQueue,
          INBOUND_DEAD_LETTER_QUEUE_NAME: inboundDeadLetter.queueName,
          DELIVERY_RESULT_QUEUE_NAME: deliveryResultQueue.queueName,
          DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME: deliveryResultDeadLetter.queueName,
          OUTBOUND_DEAD_LETTER_QUEUE_NAME: outboundDeadLetter.queueName,
          OUTBOUND_QUEUE: outboundQueue,
          OWNER_RUN_COORDINATOR: ownerRunCoordinator,
          REMINDER_CLOCK: reminderClock,
          OWNER_ID: Redacted.make(ENV.OWNER_ID),
          OWNER_TIME_ZONE: ENV.OWNER_TIME_ZONE,
          REMINDER_QUIET_HOURS_START: ENV.REMINDER_QUIET_HOURS_START,
          REMINDER_QUIET_HOURS_END: ENV.REMINDER_QUIET_HOURS_END,
          REMINDER_DAILY_LIMIT: ENV.REMINDER_DAILY_LIMIT,
          DATA_KEK_ACTIVE_VERSION: Redacted.make(ENV.DATA_KEK_ACTIVE_VERSION),
          DATA_KEK_KEYRING_JSON: Redacted.make(ENV.DATA_KEK_KEYRING_JSON),
          DATA_LOOKUP_KEY: Redacted.make(ENV.DATA_LOOKUP_KEY),
          BETTER_AUTH_SECRET: Redacted.make(ENV.BETTER_AUTH_SECRET),
          INGRESS_CALLER_SECRET: ingressCallerSecret,
          EGRESS_CALLER_SECRET: egressCallerSecret,
          SENDBLUE_EGRESS_URL: `https://${egressHost}`,
          ACCESS_TEAM_DOMAIN: ENV.ACCESS_TEAM_DOMAIN,
          CORE_ACCESS_AUDIENCE: coreApplication.aud,
          SETUP_ACCESS_AUDIENCE: setupApplication.aud,
          OWNER_ACCESS_EMAIL: Redacted.make(ENV.OWNER_ACCESS_EMAIL),
          AGENT_CALLER_SUBJECT: agentToCore.clientId,
          AGENT_URL: `https://${agentHost}`,
          AGENT_ACCESS_CLIENT_ID: Output.map(coreToAgent.clientId, Redacted.make),
          AGENT_ACCESS_CLIENT_SECRET: Output.map(coreToAgent.clientSecret, (value) =>
            requiredGeneratedSecret(value, "CoreToAgent client secret")
          ),
          AGENT_ADMIN_URL: `https://${agentAdminHost}`,
          AGENT_ADMIN_ACCESS_CLIENT_ID: Output.map(coreToAgentAdmin.clientId, Redacted.make),
          AGENT_ADMIN_ACCESS_CLIENT_SECRET: Output.map(coreToAgentAdmin.clientSecret, (value) =>
            requiredGeneratedSecret(value, "CoreToAgentAdmin client secret")
          ),
          UI_BASE_URL: `https://${coreHost}`,
          NANGO_API_URL: `https://${nangoHost}`,
          NANGO_SECRET_KEY: Redacted.make(ENV.NANGO_SECRET_KEY),
          NANGO_GOOGLE_CALENDAR_INTEGRATION_ID: "bob-google-calendar",
          NANGO_MICROSOFT_CALENDAR_INTEGRATION_ID: "bob-microsoft-calendar",
          BOB_MODEL: ENV.BOB_MODEL,
          BOB_PROVIDER: ENV.BOB_PROVIDER,
          BOB_RUN_TOKEN_BUDGET: ENV.BOB_RUN_TOKEN_BUDGET,
          BOB_DAILY_TOKEN_BUDGET: ENV.BOB_DAILY_TOKEN_BUDGET,
          BOB_RELEASE_SHA: ENV.BOB_RELEASE_SHA,
          OTEL_EXPORTER_OTLP_ENDPOINT: `https://${otlpHost}`,
          OTEL_ACCESS_CLIENT_ID: Output.map(workerToOtlp.clientId, Redacted.make),
          OTEL_ACCESS_CLIENT_SECRET: Output.map(workerToOtlp.clientSecret, (value) =>
            requiredGeneratedSecret(value, "WorkerToOtlp client secret")
          )
        }
      })

      let ingressUrl: typeof coreWorker.url | undefined
      if (sendblueActive) {
        yield* Cloudflare.Queues.Consumer("InboundConsumer", {
          queueId: inboundQueue.queueId,
          scriptName: coreWorker.workerName,
          deadLetterQueue: inboundDeadLetter.queueName,
          settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 5, maxWaitTimeMs: 1_000 }
        })
        yield* Cloudflare.Queues.Consumer("InboundDeadLetterConsumer", {
          queueId: inboundDeadLetter.queueId,
          scriptName: coreWorker.workerName,
          settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 10, maxWaitTimeMs: 1_000 }
        })
        yield* Cloudflare.Queues.Consumer("DeliveryResultConsumer", {
          queueId: deliveryResultQueue.queueId,
          scriptName: coreWorker.workerName,
          deadLetterQueue: deliveryResultDeadLetter.queueName,
          settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 10, maxWaitTimeMs: 1_000 }
        })
        yield* Cloudflare.Queues.Consumer("DeliveryResultDeadLetterConsumer", {
          queueId: deliveryResultDeadLetter.queueId,
          scriptName: coreWorker.workerName,
          settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 100, maxWaitTimeMs: 1_000 }
        })
        const accountId = requiredSendblue(ENV.SENDBLUE_ACCOUNT_ID, "SENDBLUE_ACCOUNT_ID")
        const lineId = requiredSendblue(ENV.SENDBLUE_LINE_ID, "SENDBLUE_LINE_ID")
        const webhookSecret = requiredSendblue(
          ENV.SENDBLUE_WEBHOOK_SIGNING_SECRET,
          "SENDBLUE_WEBHOOK_SIGNING_SECRET"
        )
        const fromNumber = requiredSendblue(ENV.SENDBLUE_FROM_NUMBER, "SENDBLUE_FROM_NUMBER")
        const ownerNumber = requiredSendblue(
          ENV.SENDBLUE_ALLOWED_USER_NUMBER,
          "SENDBLUE_ALLOWED_USER_NUMBER"
        )

        const ingress = yield* Cloudflare.Worker("SendblueIngress", {
          main: "../../apps/sendblue-ingress/src/index.ts",
          workersDev: false,
          domain: ingressHost,
          compatibility: { date: "2026-08-10" },
          observability: {
            enabled: true,
            logs: { enabled: true, invocationLogs: true },
            traces: { enabled: true, headSamplingRate: 1, persist: true }
          },
          env: {
            CORE: coreWorker,
            INBOUND_QUEUE: inboundQueue,
            SENDBLUE_ACCOUNT_ID: Redacted.make(accountId),
            SENDBLUE_LINE_ID: Redacted.make(lineId),
            SENDBLUE_WEBHOOK_SIGNING_SECRET: Redacted.make(webhookSecret),
            SENDBLUE_FROM_NUMBER: Redacted.make(fromNumber),
            SENDBLUE_ALLOWED_USER_NUMBER: Redacted.make(ownerNumber),
            CORE_CALLER_SECRET: ingressCallerSecret,
            BOB_RELEASE_SHA: ENV.BOB_RELEASE_SHA,
            OTEL_EXPORTER_OTLP_ENDPOINT: `https://${otlpHost}`,
            OTEL_ACCESS_CLIENT_ID: Output.map(workerToOtlp.clientId, Redacted.make),
            OTEL_ACCESS_CLIENT_SECRET: Output.map(workerToOtlp.clientSecret, (value) =>
              requiredGeneratedSecret(value, "WorkerToOtlp client secret")
            )
          }
        })
        ingressUrl = ingress.url

        const egress = yield* Cloudflare.Worker("SendblueEgress", {
          main: "../../apps/sendblue-egress/src/index.ts",
          workersDev: false,
          domain: egressHost,
          crons: ["*/2 * * * *"],
          compatibility: { date: "2026-08-10" },
          observability: {
            enabled: true,
            logs: { enabled: true, invocationLogs: true },
            traces: { enabled: true, headSamplingRate: 1, persist: true }
          },
          env: {
            CORE: coreWorker,
            INGRESS: ingress,
            DELIVERY_RESULT_QUEUE: deliveryResultQueue,
            SENDBLUE_API_KEY_ID: Redacted.make(
              requiredSendblue(ENV.SENDBLUE_API_KEY_ID, "SENDBLUE_API_KEY_ID")
            ),
            SENDBLUE_API_SECRET_KEY: Redacted.make(
              requiredSendblue(ENV.SENDBLUE_API_SECRET_KEY, "SENDBLUE_API_SECRET_KEY")
            ),
            SENDBLUE_WEBHOOK_SIGNING_SECRET: Redacted.make(webhookSecret),
            SENDBLUE_FROM_NUMBER: Redacted.make(fromNumber),
            SENDBLUE_ALLOWED_USER_NUMBER: Redacted.make(ownerNumber),
            SENDBLUE_STATUS_CALLBACK_URL: Output.map(
              ingress.url,
              () => `https://${ingressHost}/webhooks/outbound`
            ),
            CORE_CALLER_SECRET: egressCallerSecret,
            BOB_RELEASE_SHA: ENV.BOB_RELEASE_SHA,
            OTEL_EXPORTER_OTLP_ENDPOINT: `https://${otlpHost}`,
            OTEL_ACCESS_CLIENT_ID: Output.map(workerToOtlp.clientId, Redacted.make),
            OTEL_ACCESS_CLIENT_SECRET: Output.map(workerToOtlp.clientSecret, (value) =>
              requiredGeneratedSecret(value, "WorkerToOtlp client secret")
            )
          }
        })
        yield* Cloudflare.Queues.Consumer("OutboundConsumer", {
          queueId: outboundQueue.queueId,
          scriptName: egress.workerName,
          deadLetterQueue: outboundDeadLetter.queueName,
          settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 3, maxWaitTimeMs: 1_000 }
        })
        yield* Cloudflare.Queues.Consumer("OutboundDeadLetterConsumer", {
          queueId: outboundDeadLetter.queueId,
          scriptName: coreWorker.workerName,
          settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 10, maxWaitTimeMs: 1_000 }
        })
      }

      yield* RuntimeCredentialHandoff({
        accessTeamDomain: ENV.ACCESS_TEAM_DOMAIN,
        coreUrl: `https://${coreHost}`,
        runAudience: agentApplication.aud,
        adminAudience: agentAdminApplication.aud,
        coreToAgentClientId: coreToAgent.clientId,
        coreToAgentClientSecret: Output.map(coreToAgent.clientSecret, (value) =>
          requiredGeneratedSecret(value, "CoreToAgent client secret")
        ),
        coreToAgentAdminClientId: coreToAgentAdmin.clientId,
        coreToAgentAdminClientSecret: Output.map(coreToAgentAdmin.clientSecret, (value) =>
          requiredGeneratedSecret(value, "CoreToAgentAdmin client secret")
        ),
        agentToCoreClientId: agentToCore.clientId,
        agentToCoreClientSecret: Output.map(agentToCore.clientSecret, (value) =>
          requiredGeneratedSecret(value, "AgentToCore client secret")
        )
      })

      return {
        stage: PRODUCTION_STAGE,
        coreUrl: `https://${coreHost}`,
        ingressUrl,
        coreAccessAudience: coreApplication.aud,
        agentAccessAudience: agentApplication.aud,
        agentAdminAccessAudience: agentAdminApplication.aud,
        workerOtlpAccessAudience: workerOtlpApplication.aud,
        otlpUrl: `https://${otlpHost}`,
        accessTeamDomain: ENV.ACCESS_TEAM_DOMAIN,
        agentToCoreClientId: agentToCore.clientId,
        coreToAgentClientId: coreToAgent.clientId,
        coreToAgentAdminClientId: coreToAgentAdmin.clientId,
        workerToOtlpClientId: workerToOtlp.clientId
      }
    })
  )
}
