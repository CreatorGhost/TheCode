import { expect } from "bun:test"
import { Credential } from "@opencode-ai/core/credential"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  AnthropicSubscriptionIntegrationID,
  AnthropicSubscriptionMethodID,
} from "@opencode-ai/core/plugin/provider/anthropic-subscription"
import { Effect } from "effect"
import { Auth } from "@/auth"
import {
  migrateAnthropicSubscriptionCredential,
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
  }),
)
