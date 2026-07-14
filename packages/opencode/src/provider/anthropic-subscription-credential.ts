import { Effect, Semaphore } from "effect"

const lock = Semaphore.makeUnsafe(1)

export const withAnthropicSubscriptionCredentialLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  lock.withPermit(effect)
