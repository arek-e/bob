import { Effect } from "effect"

type PromiseMethod = (...arguments_: unknown[]) => Promise<unknown>

export type EffectAdapter<Adapter, Error> = {
  readonly [Key in keyof Adapter]: Adapter[Key] extends (
    ...arguments_: infer Arguments
  ) => Promise<infer Success>
    ? (...arguments_: Arguments) => Effect.Effect<Success, Error>
    : never
}

/** Lift a hosting or persistence Adapter into an Effect Module implementation. */
export function liftPromiseAdapter<Adapter extends object, Error>(
  adapter: Adapter,
  onError: (operation: keyof Adapter, cause: unknown) => Error
): EffectAdapter<Adapter, Error> {
  return new Proxy({} as EffectAdapter<Adapter, Error>, {
    get(_target, property) {
      const operation = property as keyof Adapter
      const method = adapter[operation] as PromiseMethod
      return Effect.fnUntraced(function* (...arguments_: unknown[]) {
        return yield* Effect.tryPromise({
          try: () => method.apply(adapter, arguments_),
          catch: (cause) => onError(operation, cause)
        })
      })
    }
  })
}
