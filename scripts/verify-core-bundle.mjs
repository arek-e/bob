import { readFile } from "node:fs/promises"

const bundle = await readFile(new URL("../apps/core-worker/dist/index.js", import.meta.url), "utf8")

for (const verticalMarker of [
  "reminder_create",
  "journal_link_create",
  "workout_start",
  "connection_list",
  "training_plan"
]) {
  if (bundle.includes(verticalMarker)) {
    throw new Error(`Core bundle contains an optional Vertical marker: ${verticalMarker}`)
  }
}
