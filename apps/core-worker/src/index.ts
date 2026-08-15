import { OwnerRunCoordinator } from "./entrypoints/durable-objects.ts"
import { ReminderClock } from "./modules/reminders/clock.ts"
import { createCoreWorker } from "./worker.ts"

export { OwnerRunCoordinator, ReminderClock, createCoreWorker }
export type { CoreWorkerDependencies } from "./worker.ts"

export default createCoreWorker()
