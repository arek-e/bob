import type * as Resource from "alchemy/Resource"

import * as Cloudflare from "alchemy/Cloudflare"
import * as Provider from "alchemy/Provider"
import * as Random from "alchemy/Random"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const resourceTypes = [
  "Cloudflare.D1Database",
  "Cloudflare.R2.Bucket",
  "Cloudflare.Queues.Queue",
  "Cloudflare.Queues.Consumer",
  "Cloudflare.Access.ServiceToken",
  "Cloudflare.Access.Policy",
  "Cloudflare.Access.Application",
  "Cloudflare.Tunnel.Tunnel",
  "Cloudflare.DNS.Record",
  "Cloudflare.Worker"
] as const

const offlineProvider: Provider.ProviderService = {
  reconcile: () => Effect.die(new Error("The compatibility provider cannot apply resources")),
  delete: () => Effect.die(new Error("The compatibility provider cannot delete resources")),
  list: () => Effect.succeed([])
}

const providers: Record<string, Provider.ProviderService> = Object.fromEntries(
  resourceTypes.map((type) => [type, offlineProvider])
)

const collection: Provider.ProviderCollectionService = {
  kind: "ProviderCollection",
  providers,
  get<ResolvedResource extends Resource.ResourceLike>(type: string) {
    return providers[type] as Provider.ProviderService<ResolvedResource> | undefined
  }
}

/**
 * This layer compiles and plans Bob without network access. Its providers can
 * observe resource declarations, but they fail closed if an apply is attempted.
 */
export function smokeProviders(): ReturnType<typeof Cloudflare.providers> {
  return Layer.merge(
    Layer.succeed(Cloudflare.Providers, collection),
    Random.RandomProvider()
  ) as ReturnType<typeof Cloudflare.providers>
}
