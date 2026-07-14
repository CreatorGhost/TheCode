import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import {
  AnthropicSubscriptionIntegrationID,
  AnthropicSubscriptionMethodID,
  AnthropicSubscriptionProviderID,
  makeAnthropicSubscriptionPlugin,
} from "@opencode-ai/core/plugin/provider/anthropic-subscription"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* (plugin: ReturnType<typeof makeAnthropicSubscriptionPlugin>) {
  const plugins = yield* PluginV2.Service
  yield* plugin.effect(yield* PluginHost.make(plugins))
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

describe("AnthropicSubscriptionPlugin", () => {
  it.effect("clones Claude catalog models under a zero-cost provider", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((draft) => {
        draft.provider.update(ProviderV2.ID.anthropic, (provider) => {
          provider.name = "Anthropic"
          provider.api = { type: "aisdk", package: "@ai-sdk/anthropic", url: "https://api.anthropic.com/v1" }
          provider.request.headers["anthropic-beta"] = "existing-beta"
        })
        draft.model.update(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-sonnet-test"), (model) => {
          model.name = "Claude Sonnet Test"
          model.api = {
            type: "aisdk",
            package: "@ai-sdk/anthropic",
            id: ModelV2.ID.make("claude-sonnet-test"),
          }
          model.cost = [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }]
          model.limit = { context: 200_000, output: 8_192 }
        })
        draft.model.update(ProviderV2.ID.anthropic, ModelV2.ID.make("not-claude"), (model) => {
          model.api = { type: "aisdk", package: "@ai-sdk/anthropic", id: ModelV2.ID.make("not-claude") }
        })
      })

      yield* addPlugin(makeAnthropicSubscriptionPlugin())

      const provider = required(yield* catalog.provider.get(AnthropicSubscriptionProviderID))
      expect(provider).toMatchObject({
        id: AnthropicSubscriptionProviderID,
        integrationID: AnthropicSubscriptionIntegrationID,
        name: "Claude Pro/Max",
        api: { type: "aisdk", package: "@ai-sdk/anthropic", url: "https://api.anthropic.com/v1" },
      })
      expect(provider.request.headers["anthropic-beta"]).toBe("existing-beta")
      const model = required(
        yield* catalog.model.get(AnthropicSubscriptionProviderID, ModelV2.ID.make("claude-sonnet-test")),
      )
      expect(model.providerID).toBe(AnthropicSubscriptionProviderID)
      expect(model.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
      expect(yield* catalog.model.get(AnthropicSubscriptionProviderID, ModelV2.ID.make("not-claude"))).toBeUndefined()
      yield* (yield* Credential.Service).create({
        integrationID: AnthropicSubscriptionIntegrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: AnthropicSubscriptionMethodID,
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 3_600_000,
        }),
      })
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_subscription_plugin"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { providerID: AnthropicSubscriptionProviderID, id: model.id },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })
      const resolved = yield* Effect.gen(function* () {
        return yield* (yield* SessionRunnerModel.Service).resolve(session)
      }).pipe(Effect.provide(SessionRunnerModel.locationLayer))
      expect(resolved).toMatchObject({
        provider: "anthropic-subscription",
        route: { id: "anthropic-subscription" },
      })
    }),
  )

  it.effect("validates OAuth state and refreshes rotated credentials", () =>
    Effect.gen(function* () {
      const requests: Request[] = []
      const clock = { now: -3_599_000 }
      yield* addPlugin(
        makeAnthropicSubscriptionPlugin({
          authorizationOrigin: "https://login.test",
          tokenEndpoint: "https://tokens.test/oauth/token",
          now: () => clock.now,
          async request(input, init) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
            const request = new Request(url, init)
            requests.push(request)
            const body = (await request.clone().json()) as { grant_type: string }
            if (body.grant_type === "refresh_token") {
              return Response.json({
                access_token: "access-refreshed",
                refresh_token: "refresh-rotated",
                expires_in: 3600,
              })
            }
            return Response.json({ access_token: "access-initial", refresh_token: "refresh-initial", expires_in: 3600 })
          },
        }),
      )
      const integrations = yield* Integration.Service
      const info = required(yield* integrations.get(AnthropicSubscriptionIntegrationID))
      expect(info.name).toBe("Claude Pro/Max")
      expect(info.methods).toEqual([
        {
          id: AnthropicSubscriptionMethodID,
          type: "oauth",
          label: "Claude Pro/Max subscription",
        },
      ])

      const invalid = yield* integrations.connection.oauth({
        integrationID: AnthropicSubscriptionIntegrationID,
        methodID: AnthropicSubscriptionMethodID,
        inputs: {},
      })
      yield* integrations.attempt.complete({ attemptID: invalid.attemptID, code: "code#wrong" }).pipe(Effect.flip)
      expect(requests).toHaveLength(0)

      const attempt = yield* integrations.connection.oauth({
        integrationID: AnthropicSubscriptionIntegrationID,
        methodID: AnthropicSubscriptionMethodID,
        inputs: {},
      })
      const state = new URL(attempt.url).searchParams.get("state")
      expect(state).toBeTruthy()
      yield* integrations.attempt.complete({ attemptID: attempt.attemptID, code: `code#${state}` })
      expect(requests).toHaveLength(1)

      const connection = required(yield* integrations.connection.active(AnthropicSubscriptionIntegrationID))
      clock.now = 0
      const resolved = yield* Effect.all(
        [integrations.connection.resolve(connection), integrations.connection.resolve(connection)],
        { concurrency: "unbounded" },
      )
      resolved.forEach((credential) =>
        expect(credential).toMatchObject({
          type: "oauth",
          methodID: AnthropicSubscriptionMethodID,
          access: "access-refreshed",
          refresh: "refresh-rotated",
          expires: 3_600_000,
        }),
      )
      expect(requests).toHaveLength(2)
      expect(requests[0].headers.get("anthropic-beta")).toBe("oauth-2025-04-20")
    }),
  )

  it.effect("shares failed refreshes across concurrent credential resolution", () =>
    Effect.gen(function* () {
      const gate = Promise.withResolvers<void>()
      const requests: Request[] = []
      yield* addPlugin(
        makeAnthropicSubscriptionPlugin({
          tokenEndpoint: "https://tokens.test/oauth/token",
          async request(input, init) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
            requests.push(new Request(url, init))
            await gate.promise
            return new Response("{}", { status: 500 })
          },
        }),
      )
      yield* (yield* Credential.Service).create({
        integrationID: AnthropicSubscriptionIntegrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: AnthropicSubscriptionMethodID,
          access: "expired",
          refresh: "refresh-failure",
          expires: 0,
        }),
      })
      const integrations = yield* Integration.Service
      const connection = required(yield* integrations.connection.active(AnthropicSubscriptionIntegrationID))
      const first = yield* integrations.connection.resolve(connection).pipe(Effect.exit, Effect.forkChild)
      const second = yield* integrations.connection.resolve(connection).pipe(Effect.exit, Effect.forkChild)
      yield* Effect.promise(async () => {
        while (requests.length === 0) await Bun.sleep(1)
      })
      expect(requests).toHaveLength(1)
      gate.resolve()
      const exits = yield* Effect.all([Fiber.join(first), Fiber.join(second)])

      expect(exits.map((exit) => exit._tag)).toEqual(["Failure", "Failure"])
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("does not overwrite a credential reconnected during refresh", () =>
    Effect.gen(function* () {
      const gate = Promise.withResolvers<void>()
      const requests: Request[] = []
      yield* addPlugin(
        makeAnthropicSubscriptionPlugin({
          tokenEndpoint: "https://tokens.test/oauth/token",
          async request(input, init) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
            requests.push(new Request(url, init))
            await gate.promise
            return Response.json({
              access_token: "stale-access",
              refresh_token: "stale-refresh",
              expires_in: 3600,
            })
          },
        }),
      )
      const credentials = yield* Credential.Service
      const stored = yield* credentials.create({
        integrationID: AnthropicSubscriptionIntegrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: AnthropicSubscriptionMethodID,
          access: "expired",
          refresh: "refresh-race",
          expires: 0,
        }),
      })
      const integrations = yield* Integration.Service
      const connection = required(yield* integrations.connection.active(AnthropicSubscriptionIntegrationID))
      const running = yield* integrations.connection.resolve(connection).pipe(Effect.forkChild)
      yield* Effect.promise(async () => {
        while (requests.length === 0) await Bun.sleep(1)
      })
      yield* credentials.update(stored.id, {
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: AnthropicSubscriptionMethodID,
          access: "reconnected-access",
          refresh: "reconnected-refresh",
          expires: 7_200_000,
        }),
      })
      gate.resolve()

      expect(yield* Fiber.join(running)).toMatchObject({
        access: "reconnected-access",
        refresh: "reconnected-refresh",
      })
      expect((yield* credentials.get(stored.id))?.value).toMatchObject({
        access: "reconnected-access",
        refresh: "reconnected-refresh",
      })
    }),
  )
})
