import { Effect } from "effect"

export type EffectAdapter<Adapter, Error> = {
  readonly [Key in keyof Adapter]: Adapter[Key] extends (
    ...arguments_: infer Arguments
  ) => Promise<infer Success>
    ? (...arguments_: Arguments) => Effect.Effect<Success, Error>
    : never
}

/** Lift one hosting or persistence operation into an Effect Module operation. */
export function liftPromiseOperation<Arguments extends readonly unknown[], Success, Error>(
  method: (...arguments_: Arguments) => Promise<Success>,
  onError: (cause: unknown) => Error
) {
  return (...arguments_: Arguments): Effect.Effect<Success, Error> =>
    Effect.tryPromise({
      try: () => method(...arguments_),
      catch: onError
    })
}
