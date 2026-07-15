import { Auth } from "@/auth"

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Credential } from "@opencode-ai/core/credential"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import {
  AnthropicSubscriptionIntegrationID,
  AnthropicSubscriptionMethodID,
  AnthropicSubscriptionProviderID,
} from "@opencode-ai/core/plugin/provider/anthropic-subscription"
import { withAnthropicSubscriptionCredentialLock } from "@/provider/anthropic-subscription-credential"

const credentialLayer = AppNodeBuilder.build(Credential.node)

function updateDurable(value?: Auth.Info) {
  return Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const previous = (yield* credentials.list(AnthropicSubscriptionIntegrationID)).at(-1)
    if (value?.type === "oauth") {
      const next = Credential.OAuth.make({
        type: "oauth",
        methodID: AnthropicSubscriptionMethodID,
        access: value.access,
        refresh: value.refresh,
        expires: value.expires,
      })
      if (previous) yield* credentials.update(previous.id, { value: next })
      else
        yield* credentials.create({
          integrationID: AnthropicSubscriptionIntegrationID,
          label: "Claude Pro/Max",
          value: next,
        })
      return previous
    }
    if (previous) yield* credentials.remove(previous.id)
    return previous
  }).pipe(Effect.provide(credentialLayer))
}

function restoreDurable(previous: Credential.Info | undefined) {
  if (!previous) return updateDurable()
  return Effect.gen(function* () {
    const credentials = yield* Credential.Service
    if (yield* credentials.get(previous.id)) yield* credentials.update(previous.id, { value: previous.value })
    else
      yield* credentials.create({
        integrationID: previous.integrationID,
        label: previous.label,
        value: previous.value,
      })
  }).pipe(Effect.provide(credentialLayer))
}

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: Auth.Info
    }) {
      if (ctx.params.providerID !== AnthropicSubscriptionProviderID) {
        yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)
        return true
      }
      yield* withAnthropicSubscriptionCredentialLock(
        Effect.gen(function* () {
          const previous = yield* updateDurable(ctx.payload)
          yield* auth.remove(ctx.params.providerID).pipe(
            Effect.tapError(() => restoreDurable(previous)),
            Effect.orDie,
          )
        }),
      )
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      if (ctx.params.providerID !== AnthropicSubscriptionProviderID) {
        yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
        return true
      }
      yield* withAnthropicSubscriptionCredentialLock(
        Effect.gen(function* () {
          const previous = yield* updateDurable()
          yield* auth.remove(ctx.params.providerID).pipe(
            Effect.tapError(() => restoreDurable(previous)),
            Effect.orDie,
          )
        }),
      )
      return true
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      const write =
        ctx.payload.level === "debug"
          ? Effect.logDebug
          : ctx.payload.level === "info"
            ? Effect.logInfo
            : ctx.payload.level === "warn"
              ? Effect.logWarning
              : Effect.logError
      yield* write(ctx.payload.message).pipe(Effect.annotateLogs(ctx.payload.extra ?? {}))
      return true
    })

    return handlers.handle("authSet", authSet).handle("authRemove", authRemove).handle("log", log)
  }),
)
