import type { ToolName } from "@bob/contracts/tools"

export function selectTools(text: string): readonly ToolName[] {
  const normalized = text.toLowerCase()
  if (/\bremind|reminder|snooze\b/.test(normalized)) {
    return ["reminder_create", "reminder_list"]
  }
  if (/\bjournal\b/.test(normalized)) {
    return ["journal_link_create", "journal_search_metadata"]
  }
  if (/\bgym|routine|workout|exercise|set\b/.test(normalized)) {
    return [
      "gym_create",
      "exercise_create",
      "gym_add_equipment",
      "equipment_map_exercise",
      "routine_save",
      "routine_get",
      "workout_start",
      "workout_log_set",
      "workout_finish",
      "workout_last",
      "workout_history"
    ]
  }
  return ["memory_search", "memory_propose", "memory_correct"]
}
