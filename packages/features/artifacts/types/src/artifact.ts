import { Schema } from "effect"

const ArtifactTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))
const ArtifactHeading = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80))
const ArtifactItem = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))

const PlanArtifactFields = {
  title: ArtifactTitle,
  durationMinutes: Schema.NullOr(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 240 }))
  ),
  sections: Schema.Array(
    Schema.Struct({
      heading: ArtifactHeading,
      items: Schema.Array(ArtifactItem).check(Schema.isMinLength(1), Schema.isMaxLength(12))
    })
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8))
}

export const PlanArtifact = Schema.Struct({
  kind: Schema.Literal("plan"),
  ...PlanArtifactFields
})

export const AgentArtifact = PlanArtifact

export type PlanArtifact = typeof PlanArtifact.Type
export type AgentArtifact = typeof AgentArtifact.Type
