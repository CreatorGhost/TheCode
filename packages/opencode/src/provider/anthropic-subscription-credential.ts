import { Credential } from "@opencode-ai/core/credential"
import {
  AnthropicSubscriptionIntegrationID,
  AnthropicSubscriptionMethodID,
  AnthropicSubscriptionProviderID,
} from "@opencode-ai/core/plugin/provider/anthropic-subscription"
import { Effect, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { Auth } from "../auth"

const lock = Semaphore.makeUnsafe(1)
const revisionKey = "opencode.internal.revision"
const pendingUntilKey = "opencode.internal.pendingUntil"
const pendingTimeoutMs = 5 * 60 * 1000

function revision(value: Credential.OAuth) {
  const revision = value.metadata?.[revisionKey]
  return typeof revision === "string" ? revision : undefined
}

function pendingUntil(value: Credential.OAuth) {
  const pendingUntil = value.metadata?.[pendingUntilKey]
  return typeof pendingUntil === "number" ? pendingUntil : 0
}

function committed(value: Credential.OAuth) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: value.methodID,
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
  })
}

function commitOAuth(
  id: Credential.ID,
  expected: Credential.OAuth,
  expectedRevision: string,
  credentials: Credential.Interface,
): Effect.Effect<Credential.OAuth, Auth.AuthError> {
  const value = committed(expected)
  return credentials.compareAndSetOAuth(id, expected, value).pipe(
    Effect.flatMap((result) => {
      if (result.updated) return Effect.succeed(value)
      if (result.value?.type !== "oauth" || result.value.methodID !== AnthropicSubscriptionMethodID) {
        return Effect.fail(new Auth.AuthError({ message: "Anthropic subscription credential changed during save" }))
      }
      const currentRevision = revision(result.value)
      if (currentRevision === expectedRevision) return commitOAuth(id, result.value, expectedRevision, credentials)
      if (currentRevision === undefined) return Effect.succeed(result.value)
      return Effect.fail(new Auth.AuthError({ message: "Anthropic subscription credential changed during save" }))
    }),
  )
}

function replaceOAuth(
  id: Credential.ID,
  expected: Credential.OAuth,
  value: Credential.OAuth,
  credentials: Credential.Interface,
): Effect.Effect<Credential.OAuth, Auth.AuthError> {
  if (revision(expected) !== undefined) {
    if (pendingUntil(expected) > Date.now()) {
      return Effect.fail(new Auth.AuthError({ message: "Anthropic subscription credential changed during save" }))
    }
    const recovered = committed(expected)
    return credentials.compareAndSetOAuth(id, expected, recovered).pipe(
      Effect.flatMap((result) => {
        if (result.updated) return replaceOAuth(id, recovered, value, credentials)
        if (result.value?.type !== "oauth" || result.value.methodID !== AnthropicSubscriptionMethodID) {
          return Effect.fail(new Auth.AuthError({ message: "Anthropic subscription credential changed during save" }))
        }
        return replaceOAuth(id, result.value, value, credentials)
      }),
    )
  }
  return credentials.compareAndSetOAuth(id, expected, value).pipe(
    Effect.flatMap((result) => {
      if (result.updated) return Effect.succeed(expected)
      if (result.value?.type !== "oauth" || result.value.methodID !== AnthropicSubscriptionMethodID) {
        return Effect.fail(new Auth.AuthError({ message: "Anthropic subscription credential changed during save" }))
      }
      if (revision(result.value) !== undefined) {
        return Effect.fail(new Auth.AuthError({ message: "Anthropic subscription credential changed during save" }))
      }
      return replaceOAuth(id, result.value, value, credentials)
    }),
  )
}

function retireLegacy(
  id: Credential.ID,
  previous: Credential.OAuth | undefined,
  pending: Credential.OAuth,
  value: Credential.OAuth,
  services: { readonly auth: Auth.Interface; readonly credentials: Credential.Interface },
): Effect.Effect<Credential.OAuth, Auth.AuthError> {
  const pendingRevision = revision(pending)
  if (!pendingRevision) {
    return Effect.fail(new Auth.AuthError({ message: "Anthropic subscription credential changed during save" }))
  }
  const rollback = previous
    ? services.credentials.compareAndSetOAuth(id, pending, previous).pipe(Effect.asVoid)
    : services.credentials.compareAndRemove(id, pending).pipe(Effect.asVoid)
  return services.auth.remove(AnthropicSubscriptionProviderID).pipe(
    Effect.onError(() => rollback),
    Effect.flatMap(() => commitOAuth(id, pending, pendingRevision, services.credentials)),
  )
}

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
  const pending = Credential.OAuth.make({
    ...next,
    metadata: { [revisionKey]: randomUUID(), [pendingUntilKey]: Date.now() + pendingTimeoutMs },
  })
  if (!previous) {
    const result = yield* services.credentials.createIfAbsent({
      integrationID: AnthropicSubscriptionIntegrationID,
      label: "Claude Pro/Max",
      value: pending,
    })
    if (result.created) {
      return yield* retireLegacy(result.credential.id, undefined, pending, next, services)
    }
    if (
      result.credential.value.type !== "oauth" ||
      result.credential.value.methodID !== AnthropicSubscriptionMethodID
    ) {
      return yield* Effect.fail(
        new Auth.AuthError({ message: "Anthropic subscription credential changed during save" }),
      )
    }
    const previousValue = yield* replaceOAuth(
      result.credential.id,
      result.credential.value,
      pending,
      services.credentials,
    )
    return yield* retireLegacy(result.credential.id, previousValue, pending, next, services)
  }
  if (previous.value.type !== "oauth" || previous.value.methodID !== AnthropicSubscriptionMethodID) {
    return yield* Effect.fail(new Auth.AuthError({ message: "Anthropic subscription credential changed during save" }))
  }
  const previousValue = yield* replaceOAuth(previous.id, previous.value, pending, services.credentials)
  return yield* retireLegacy(previous.id, previousValue, pending, next, services)
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

export const removeAnthropicSubscriptionCredential = Effect.fn("AnthropicSubscriptionCredential.remove")(
  function* (services: { readonly auth: Auth.Interface; readonly credentials: Credential.Interface }) {
    return yield* withAnthropicSubscriptionCredentialLock(
      Effect.gen(function* () {
        const previous = (yield* services.credentials.list(AnthropicSubscriptionIntegrationID)).at(-1)
        yield* services.auth.remove(AnthropicSubscriptionProviderID)
        if (previous) yield* services.credentials.compareAndRemove(previous.id, previous.value)
      }),
    )
  },
)
