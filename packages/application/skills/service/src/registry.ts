import type { ReviewedSkill, ReviewedSkillRegistry } from "@bob/skills-types/skill"

export type { ReviewedSkill, ReviewedSkillRegistry } from "@bob/skills-types/skill"

/** Skills are immutable reviewed instructions. This Interface has no mutation or Tool authority. */
export function makeReviewedSkillRegistry(
  profileId: string,
  skills: readonly ReviewedSkill[]
): ReviewedSkillRegistry {
  if (profileId.trim().length === 0) throw new Error("Reviewed Skill profile ID is required")
  const ids = new Set<string>()
  for (const skill of skills) {
    if (skill.id.trim().length === 0 || skill.version < 1) {
      throw new Error("Reviewed Skill identity is invalid")
    }
    if (ids.has(skill.id)) throw new Error(`Duplicate reviewed Skill ${skill.id}`)
    if (
      skill.instructions.trim().length === 0 ||
      skill.contentHash.trim().length === 0 ||
      skill.reviewReference.trim().length === 0
    ) {
      throw new Error(`Reviewed Skill ${skill.id} lacks review evidence`)
    }
    ids.add(skill.id)
  }
  return Object.freeze({
    profileId,
    skills: Object.freeze(skills.map((skill) => Object.freeze(skill)))
  })
}
