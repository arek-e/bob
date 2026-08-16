import type { OwnerRouteModule } from "@bob/core-types/runtime-module"

import { TrainingProposalApproval } from "@bob/training-types/ui"
import { Schema } from "effect"

import type { TrainingModule } from "./module.ts"

export function makeTrainingOwnerRoutes(training: TrainingModule): OwnerRouteModule {
  return {
    id: "training-owner-routes",
    async handle(context) {
      const { request, url, ownerId } = context
      if (request.method === "GET" && url.pathname === "/api/training/overview") {
        return { body: await training.overview(ownerId, url.searchParams.get("q") ?? undefined) }
      }
      if (request.method === "GET" && url.pathname === "/api/training/proposals") {
        return { body: { proposals: await training.listTrainingProposals(ownerId) } }
      }
      const approval = url.pathname.match(/^\/api\/training\/proposals\/([^/]+)\/approve$/)
      if (request.method !== "POST" || approval === null) return undefined
      const input = Schema.decodeUnknownSync(TrainingProposalApproval)(await context.readJson())
      return {
        body: await training.approveTrainingProposal(
          ownerId,
          decodeURIComponent(approval[1]!),
          input.proposalHash,
          context.idempotencyKey()
        )
      }
    }
  }
}
