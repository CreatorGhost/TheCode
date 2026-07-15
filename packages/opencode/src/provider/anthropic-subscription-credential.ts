import { Credential } from "@opencode-ai/core/credential"
import {
  AnthropicSubscriptionIntegrationID,
  AnthropicSubscriptionMethodID,
  AnthropicSubscriptionProviderID,
} from "@opencode-ai/core/plugin/provider/anthropic-subscription"
import { Effect, Semaphore } from "effect"
import { Auth } from "../auth"

const lock = Semaphore.makeUnsafe(1)

export const withAnthropicSubscriptionCredentialLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  lock.withPermit(effect)

const save = Effect.fn("AnthropicSubscriptionCredential.saveUnlocked")(function* (
  value: { readonly access: string; readonly refresh: string; readonly expires: number },
  services: { readonly auth: Auth.Interface; readonly credentials: Credential.Interface },
) {
  const previous = (yield* services.credentials.list(AnthropicSubscriptionIntegrationID)).at(-1)
  const next = Credential.OAuth.make({
    type: "oauth",
    methodID: AnthropicSubscriptionMethodID,
    ...value,
  })
  const created = previous
    ? yield* services.credentials.update(previous.id, { value: next }).pipe(Effect.as(previous))
    : yield* services.credentials.create({
        integrationID: AnthropicSubscriptionIntegrationID,
        label: "Claude Pro/Max",
        value: next,
      })
  yield* services.auth
    .remove(AnthropicSubscriptionProviderID)
    .pipe(
      Effect.onError(() =>
        previous
          ? services.credentials.update(previous.id, { value: previous.value })
          : services.credentials.remove(created.id),
      ),
    )
  return next
})

export const saveAnthropicSubscriptionCredential = Effect.fn("AnthropicSubscriptionCredential.save")(function* (
  value: { readonly access: string; readonly refresh: string; readonly expires: number },
  services: { readonly auth: Auth.Interface; readonly credentials: Credential.Interface },
) {
  return yield* withAnthropicSubscriptionCredentialLock(save(value, services))
})

export const migrateAnthropicSubscriptionCredential = Effect.fn("AnthropicSubscriptionCredential.migrate")(
  function* (services: { readonly auth: Auth.Interface; readonly credentials: Credential.Interface }) {
    return yield* withAnthropicSubscriptionCredentialLock(
      Effect.gen(function* () {
        const credential = (yield* services.credentials.list(AnthropicSubscriptionIntegrationID)).at(-1)
        if (credential?.value.type === "oauth") return credential.value
        const legacy = yield* services.auth.get(AnthropicSubscriptionProviderID)
        if (legacy?.type !== "oauth") return legacy
        return yield* save(legacy, services)
      }),
    )
  },
)
