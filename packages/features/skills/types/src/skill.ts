export interface ReviewedSkill {
  readonly id: string
  readonly version: number
  readonly instructions: string
  readonly contentHash: string
  readonly reviewReference: string
}

export interface ReviewedSkillRegistry {
  readonly profileId: string
  readonly skills: readonly ReviewedSkill[]
}
