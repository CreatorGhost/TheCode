import { expect } from "bun:test"
import { Credential } from "@opencode-ai/core/credential"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import {
  AnthropicSubscriptionIntegrationID,
  AnthropicSubscriptionMethodID,
} from "@opencode-ai/core/plugin/provider/anthropic-subscription"
import { Effect, Fiber } from "effect"
import { Auth } from "@/auth"
import {
  migrateAnthropicSubscriptionCredential,
  removeAnthropicSubscriptionCredential,
  saveAnthropicSubscriptionCredential,
} from "@/provider/anthropic-subscription-credential"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Credential.node))

const auth = Auth.Service.of({
  get: () => Effect.succeed(undefined),
  all: () => Effect.succeed({}),
  set: () => Effect.void,
  remove: () => Effect.fail(new Auth.AuthError({ message: "remove failed" })),
})

it.effect("restores durable credentials when legacy auth retirement fails", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const next = { access: "new-access", refresh: "new-refresh", expires: 20 }

    expect((yield* saveAnthropicSubscriptionCredential(next, { auth, credentials }).pipe(Effect.exit))._tag).toBe(
      "Failure",
    )
    expect(yield* credentials.list(AnthropicSubscriptionIntegrationID)).toEqual([])

    const previous = yield* credentials.create({
      integrationID: AnthropicSubscriptionIntegrationID,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: AnthropicSubscriptionMethodID,
        access: "old-access",
        refresh: "old-refresh",
        expires: 10,
      }),
    })
    expect((yield* saveAnthropicSubscriptionCredential(next, { auth, credentials }).pipe(Effect.exit))._tag).toBe(
      "Failure",
    )
    expect(yield* credentials.get(previous.id)).toEqual(previous)
    expect((yield* removeAnthropicSubscriptionCredential({ auth, credentials }).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* credentials.get(previous.id)).toEqual(previous)
  }),
)

it.effect("migrates durable credentials and retires legacy auth", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    let legacy: Auth.Info | undefined = new Auth.Oauth({
      type: "oauth",
      access: "legacy-access",
      refresh: "legacy-refresh",
      expires: 20,
    })
    const migratingAuth = Auth.Service.of({
      get: () => Effect.succeed(legacy),
      all: () =>
        Effect.sync(() => {
          const result: Record<string, Auth.Info> = {}
          if (legacy) result["anthropic-subscription"] = legacy
          return result
        }),
      set: (_key, value) =>
        Effect.sync(() => {
          legacy = value
        }),
      remove: () =>
        Effect.sync(() => {
          legacy = undefined
        }),
    })

    expect(yield* migrateAnthropicSubscriptionCredential({ auth: migratingAuth, credentials })).toMatchObject({
      type: "oauth",
      methodID: AnthropicSubscriptionMethodID,
      access: "legacy-access",
      refresh: "legacy-refresh",
    })
    expect(legacy).toBeUndefined()
    expect((yield* credentials.list(AnthropicSubscriptionIntegrationID))[0]?.value).toMatchObject({
      type: "oauth",
      methodID: AnthropicSubscriptionMethodID,
      access: "legacy-access",
      refresh: "legacy-refresh",
    })
    expect(
      yield* saveAnthropicSubscriptionCredential(
        { access: "updated-access", refresh: "updated-refresh", expires: 30 },
        { auth: migratingAuth, credentials },
      ),
    ).toMatchObject({ access: "updated-access", refresh: "updated-refresh" })
    expect((yield* credentials.list(AnthropicSubscriptionIntegrationID))[0]?.value).toMatchObject({
      access: "updated-access",
      refresh: "updated-refresh",
    })
  }),
)

it.effect("does not roll back a credential replaced while legacy retirement is pending", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const previous = yield* credentials.create({
      integrationID: AnthropicSubscriptionIntegrationID,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: AnthropicSubscriptionMethodID,
        access: "old-access",
        refresh: "old-refresh",
        expires: 10,
      }),
    })
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const blockedAuth = Auth.Service.of({
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed({}),
      set: () => Effect.void,
      remove: () =>
        Effect.gen(function* () {
          started.resolve()
          yield* Effect.promise(() => release.promise)
          return yield* Effect.fail(new Auth.AuthError({ message: "remove failed" }))
        }),
    })
    const running = yield* saveAnthropicSubscriptionCredential(
      { access: "new-access", refresh: "new-refresh", expires: 20 },
      { auth: blockedAuth, credentials },
    ).pipe(Effect.exit, Effect.forkChild)
    yield* Effect.promise(() => started.promise)
    const owned = (yield* credentials.get(previous.id))?.value
    if (owned?.type !== "oauth") throw new Error("Expected OAuth credential")
    const concurrent = Credential.OAuth.make({
      ...owned,
      metadata: { "opencode.internal.revision": "concurrent" },
    })
    yield* credentials.update(previous.id, { value: concurrent })
    release.resolve()

    expect((yield* Fiber.join(running))._tag).toBe("Failure")
    expect((yield* credentials.get(previous.id))?.value).toEqual(concurrent)
  }),
)

it.effect("retries a save when a token refresh wins the first credential update", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const original = Credential.OAuth.make({
      type: "oauth",
      methodID: AnthropicSubscriptionMethodID,
      access: "old-access",
      refresh: "old-refresh",
      expires: 10,
    })
    const previous = yield* credentials.create({
      integrationID: AnthropicSubscriptionIntegrationID,
      value: original,
    })
    const refreshed = Credential.OAuth.make({ ...original, access: "refreshed-access", expires: 15 })
    const race = { pending: true }
    const racingCredentials = Credential.Service.of({
      ...credentials,
      compareAndSetOAuth: (id, expected, value) =>
        Effect.gen(function* () {
          if (race.pending) {
            race.pending = false
            yield* credentials.update(id, { value: refreshed })
          }
          return yield* credentials.compareAndSetOAuth(id, expected, value)
        }),
    })
    const successfulAuth = Auth.Service.of({
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed({}),
      set: () => Effect.void,
      remove: () => Effect.void,
    })

    expect(
      yield* saveAnthropicSubscriptionCredential(
        { access: "new-access", refresh: "new-refresh", expires: 20 },
        { auth: successfulAuth, credentials: racingCredentials },
      ),
    ).toMatchObject({ access: "new-access", refresh: "new-refresh" })
    expect((yield* credentials.get(previous.id))?.value).toMatchObject({
      access: "new-access",
      refresh: "new-refresh",
    })
  }),
)

it.effect("does not overwrite a credential claimed by a concurrent save", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const original = Credential.OAuth.make({
      type: "oauth",
      methodID: AnthropicSubscriptionMethodID,
      access: "old-access",
      refresh: "old-refresh",
      expires: 10,
    })
    const previous = yield* credentials.create({
      integrationID: AnthropicSubscriptionIntegrationID,
      value: original,
    })
    const concurrent = Credential.OAuth.make({
      ...original,
      access: "concurrent-access",
      metadata: { "opencode.internal.revision": "concurrent" },
    })
    const race = { pending: true }
    const racingCredentials = Credential.Service.of({
      ...credentials,
      compareAndSetOAuth: (id, expected, value) =>
        Effect.gen(function* () {
          if (race.pending) {
            race.pending = false
            yield* credentials.update(id, { value: concurrent })
          }
          return yield* credentials.compareAndSetOAuth(id, expected, value)
        }),
    })
    const successfulAuth = Auth.Service.of({
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed({}),
      set: () => Effect.void,
      remove: () => Effect.void,
    })

    expect(
      (yield* saveAnthropicSubscriptionCredential(
        { access: "new-access", refresh: "new-refresh", expires: 20 },
        { auth: successfulAuth, credentials: racingCredentials },
      ).pipe(Effect.exit))._tag,
    ).toBe("Failure")
    expect((yield* credentials.get(previous.id))?.value).toEqual(concurrent)
  }),
)

it.effect("does not replace a credential owned by another OAuth method", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const existing = yield* credentials.create({
      integrationID: AnthropicSubscriptionIntegrationID,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("other-method"),
        access: "other-access",
        refresh: "other-refresh",
        expires: 20,
      }),
    })
    const successfulAuth = Auth.Service.of({
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed({}),
      set: () => Effect.void,
      remove: () => Effect.void,
    })

    expect(
      (yield* saveAnthropicSubscriptionCredential(
        { access: "new-access", refresh: "new-refresh", expires: 30 },
        { auth: successfulAuth, credentials },
      ).pipe(Effect.exit))._tag,
    ).toBe("Failure")
    expect(yield* credentials.get(existing.id)).toEqual(existing)
  }),
)

it.effect("rejects a save started while another save is pending", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const pending = Credential.OAuth.make({
      type: "oauth",
      methodID: AnthropicSubscriptionMethodID,
      access: "pending-access",
      refresh: "pending-refresh",
      expires: 20,
      metadata: {
        "opencode.internal.revision": "pending",
        "opencode.internal.pendingUntil": Date.now() + 60_000,
      },
    })
    const previous = yield* credentials.create({
      integrationID: AnthropicSubscriptionIntegrationID,
      value: pending,
    })
    const successfulAuth = Auth.Service.of({
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed({}),
      set: () => Effect.void,
      remove: () => Effect.void,
    })

    expect(
      (yield* saveAnthropicSubscriptionCredential(
        { access: "new-access", refresh: "new-refresh", expires: 30 },
        { auth: successfulAuth, credentials },
      ).pipe(Effect.exit))._tag,
    ).toBe("Failure")
    expect((yield* credentials.get(previous.id))?.value).toEqual(pending)
  }),
)

it.effect("recovers a pending save whose owner lease expired", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const pending = Credential.OAuth.make({
      type: "oauth",
      methodID: AnthropicSubscriptionMethodID,
      access: "pending-access",
      refresh: "pending-refresh",
      expires: 20,
      metadata: {
        "opencode.internal.revision": "abandoned",
        "opencode.internal.pendingUntil": 0,
      },
    })
    const previous = yield* credentials.create({
      integrationID: AnthropicSubscriptionIntegrationID,
      value: pending,
    })
    const successfulAuth = Auth.Service.of({
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed({}),
      set: () => Effect.void,
      remove: () => Effect.void,
    })

    const saved = yield* saveAnthropicSubscriptionCredential(
      { access: "new-access", refresh: "new-refresh", expires: 30 },
      { auth: successfulAuth, credentials },
    )
    expect(saved).toMatchObject({ access: "new-access", refresh: "new-refresh" })
    expect(saved.metadata).toBeUndefined()
    const stored = (yield* credentials.get(previous.id))?.value
    expect(stored).toMatchObject({
      access: "new-access",
      refresh: "new-refresh",
    })
    expect(stored?.metadata).toBeUndefined()
  }),
)

it.effect("commits a token refresh that wins during legacy retirement", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    yield* credentials.create({
      integrationID: AnthropicSubscriptionIntegrationID,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: AnthropicSubscriptionMethodID,
        access: "old-access",
        refresh: "old-refresh",
        expires: 10,
      }),
    })
    const refreshingAuth = Auth.Service.of({
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed({}),
      set: () => Effect.void,
      remove: () =>
        Effect.gen(function* () {
          const pending = (yield* credentials.list(AnthropicSubscriptionIntegrationID))[0]
          if (pending?.value.type !== "oauth") throw new Error("Expected pending OAuth credential")
          yield* credentials.update(pending.id, {
            value: Credential.OAuth.make({
              ...pending.value,
              access: "refreshed-access",
              refresh: "refreshed-refresh",
              expires: 40,
            }),
          })
        }),
    })

    expect(
      yield* saveAnthropicSubscriptionCredential(
        { access: "new-access", refresh: "new-refresh", expires: 30 },
        { auth: refreshingAuth, credentials },
      ),
    ).toMatchObject({ access: "refreshed-access", refresh: "refreshed-refresh", expires: 40 })
    const stored = (yield* credentials.list(AnthropicSubscriptionIntegrationID))[0]?.value
    expect(stored).toMatchObject({ access: "refreshed-access", refresh: "refreshed-refresh", expires: 40 })
    expect(stored?.metadata).toBeUndefined()
  }),
)

it.effect("does not remove a credential replaced while legacy logout is pending", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const original = Credential.OAuth.make({
      type: "oauth",
      methodID: AnthropicSubscriptionMethodID,
      access: "old-access",
      refresh: "old-refresh",
      expires: 10,
    })
    const previous = yield* credentials.create({
      integrationID: AnthropicSubscriptionIntegrationID,
      value: original,
    })
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const blockedAuth = Auth.Service.of({
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed({}),
      set: () => Effect.void,
      remove: () =>
        Effect.gen(function* () {
          started.resolve()
          yield* Effect.promise(() => release.promise)
        }),
    })
    const running = yield* removeAnthropicSubscriptionCredential({ auth: blockedAuth, credentials }).pipe(
      Effect.forkChild,
    )
    yield* Effect.promise(() => started.promise)
    const concurrent = Credential.OAuth.make({ ...original, access: "concurrent-access" })
    yield* credentials.update(previous.id, { value: concurrent })
    release.resolve()

    yield* Fiber.join(running)
    expect((yield* credentials.get(previous.id))?.value).toEqual(concurrent)
  }),
)
