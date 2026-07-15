import { Auth } from "@/auth"

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Credential } from "@opencode-ai/core/credential"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AnthropicSubscriptionProviderID } from "@opencode-ai/core/plugin/provider/anthropic-subscription"
import {
  removeAnthropicSubscriptionCredential,
  saveAnthropicSubscriptionCredential,
} from "@/provider/anthropic-subscription-credential"

const credentialLayer = AppNodeBuilder.build(Credential.node)

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
      yield* Effect.gen(function* () {
        const credentials = yield* Credential.Service
        if (ctx.payload.type !== "oauth") {
          yield* removeAnthropicSubscriptionCredential({ auth, credentials })
          return
        }
        yield* saveAnthropicSubscriptionCredential(
          { access: ctx.payload.access, refresh: ctx.payload.refresh, expires: ctx.payload.expires },
          { auth, credentials },
        )
      }).pipe(Effect.provide(credentialLayer), Effect.orDie)
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      if (ctx.params.providerID !== AnthropicSubscriptionProviderID) {
        yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
        return true
      }
      yield* Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* removeAnthropicSubscriptionCredential({ auth, credentials })
      }).pipe(Effect.provide(credentialLayer), Effect.orDie)
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
