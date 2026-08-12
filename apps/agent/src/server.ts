import type { Server } from "node:http"

import { Effect } from "effect"

export function serveAgent(
  server: Server,
  options: {
    readonly host: string
    readonly port: number
    readonly disposeRuntime: Effect.Effect<void>
  }
): Effect.Effect<never> {
  const listeningServer = Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const onError = (error: Error) => resume(Effect.die(error))
      server.once("error", onError)
      server.listen(options.port, options.host, () => {
        server.off("error", onError)
        resume(Effect.succeed(server))
      })
    }),
    (active) =>
      Effect.callback<void>((resume) => {
        active.close(() => resume(Effect.void))
      })
  )

  return listeningServer.pipe(
    Effect.flatMap(() => Effect.never),
    Effect.scoped,
    Effect.ensuring(options.disposeRuntime)
  )
}
