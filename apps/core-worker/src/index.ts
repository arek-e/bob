import { OwnerRunCoordinator } from "./entrypoints/durable-objects.ts"
import { createCoreWorker } from "./worker.ts"

export { OwnerRunCoordinator, createCoreWorker }
export type { CoreWorkerDependencies } from "./worker.ts"

export default createCoreWorker()
