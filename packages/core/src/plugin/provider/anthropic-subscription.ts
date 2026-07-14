import type { IntegrationOAuthMethodRegistration } from "@opencode-ai/plugin/v2/effect/integration"
import { define } from "@opencode-ai/plugin/v2/effect/plugin"
import { Effect } from "effect"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ProviderV2 } from "../../provider"
import type { PluginInternal } from "../internal"

export const AnthropicSubscriptionIntegrationID = Integration.ID.make("anthropic-subscription")
export const AnthropicSubscriptionMethodID = Integration.MethodID.make("claude-pro-max")
export const AnthropicSubscriptionProviderID = ProviderV2.ID.make("anthropic-subscription")

const clientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const authorizationOrigin = "https://claude.ai"
const tokenEndpoint = "https://console.anthropic.com/v1/oauth/token"
const redirectURI = "https://console.anthropic.com/oauth/code/callback"

type Options = {
  readonly authorizationOrigin?: string
  readonly tokenEndpoint?: string
  readonly request?: Fetch
  readonly now?: () => number
}

export type AnthropicSubscriptionTokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

type Pkce = {
  verifier: string
  challenge: string
}

type Fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>
const refreshRequests = new Map<string, Promise<AnthropicSubscriptionTokenResponse>>()

export function refreshAnthropicSubscriptionToken(input: {
  readonly refresh: string
  readonly request?: Fetch
  readonly tokenEndpoint?: string
}) {
  const endpoint = input.tokenEndpoint ?? tokenEndpoint
  const key = `${endpoint}\u0000${input.refresh}`
  const current = refreshRequests.get(key)
  if (current) return current
  const pending = tokenRequestPromise(input.request ?? fetch, endpoint, {
    grant_type: "refresh_token",
    refresh_token: input.refresh,
    client_id: clientID,
  }).finally(() => {
    if (refreshRequests.get(key) === pending) refreshRequests.delete(key)
  })
  refreshRequests.set(key, pending)
  return pending
}

export const makeAnthropicSubscriptionPlugin = (options: Options = {}) => {
  const authOrigin = options.authorizationOrigin ?? authorizationOrigin
  const tokens = options.tokenEndpoint ?? tokenEndpoint
  const request = options.request ?? fetch
  const now = options.now ?? Date.now

  const exchange = (code: string, verifier: string, state: string) => {
    const [authorizationCode, returnedState] = code.trim().split("#")
    if (!authorizationCode || returnedState !== state) return Effect.fail(new Error("Invalid OAuth state"))
    return tokenRequest(request, tokens, {
      code: authorizationCode,
      state: returnedState,
      grant_type: "authorization_code",
      client_id: clientID,
      redirect_uri: redirectURI,
      code_verifier: verifier,
    }).pipe(
      Effect.flatMap((result) => {
        if (!result.refresh_token) return Effect.fail(new Error("Anthropic did not return a refresh token"))
        return Effect.succeed(credential(result, result.refresh_token, now))
      }),
    )
  }

  const oauth = {
    integrationID: AnthropicSubscriptionIntegrationID,
    method: {
      id: AnthropicSubscriptionMethodID,
      type: "oauth",
      label: "Claude Pro/Max subscription",
    },
    authorize: () =>
      Effect.promise(generatePKCE).pipe(
        Effect.map((pkce) => {
          const state = randomState()
          const url = new URL("/oauth/authorize", authOrigin)
          url.searchParams.set("code", "true")
          url.searchParams.set("client_id", clientID)
          url.searchParams.set("response_type", "code")
          url.searchParams.set("redirect_uri", redirectURI)
          url.searchParams.set("scope", "org:create_api_key user:profile user:inference")
          url.searchParams.set("code_challenge", pkce.challenge)
          url.searchParams.set("code_challenge_method", "S256")
          url.searchParams.set("state", state)
          return {
            mode: "code" as const,
            url: url.toString(),
            instructions: "Paste the authorization code here:",
            callback: (code: string) => exchange(code, pkce.verifier, state),
          }
        }),
      ),
    refresh: (value) =>
      Effect.tryPromise({
        try: () => refreshAnthropicSubscriptionToken({ refresh: value.refresh, request, tokenEndpoint: tokens }),
        catch: (cause) => cause,
      }).pipe(Effect.map((result) => credential(result, result.refresh_token ?? value.refresh, now))),
  } satisfies IntegrationOAuthMethodRegistration

  return define({
    id: "anthropic-subscription",
    effect: Effect.fn(function* (ctx) {
      yield* ctx.integration.transform((draft) => {
        draft.update(AnthropicSubscriptionIntegrationID, (integration) => {
          integration.name = "Claude Pro/Max"
        })
        draft.method.update(oauth)
      })
      yield* ctx.catalog.transform((catalog) => {
        const source = catalog.provider.get(ProviderV2.ID.anthropic)
        if (!source) return
        catalog.provider.update(AnthropicSubscriptionProviderID, (provider) => {
          Object.assign(provider, structuredClone(source.provider))
          provider.id = AnthropicSubscriptionProviderID
          provider.integrationID = AnthropicSubscriptionIntegrationID
          provider.name = "Claude Pro/Max"
          provider.disabled = source.provider.disabled
        })
        for (const model of source.models.values()) {
          if (!model.api.id.startsWith("claude-")) continue
          catalog.model.update(AnthropicSubscriptionProviderID, model.id, (draft) => {
            Object.assign(draft, structuredClone(model))
            draft.providerID = AnthropicSubscriptionProviderID
            draft.cost = model.cost.map((cost) => ({
              ...cost,
              input: 0,
              output: 0,
              cache: { read: 0, write: 0 },
            }))
          })
        }
      })
    }),
  } satisfies PluginInternal.Plugin<PluginInternal.Requirements>)
}

export const AnthropicSubscriptionPlugin = makeAnthropicSubscriptionPlugin()

function tokenRequest(request: Fetch, url: string, body: Record<string, string>) {
  return Effect.tryPromise({
    try: (signal) => tokenRequestPromise(request, url, body, signal),
    catch: (cause) => cause,
  })
}

async function tokenRequestPromise(request: Fetch, url: string, body: Record<string, string>, signal?: AbortSignal) {
  const response = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw new Error(`Anthropic OAuth request failed: ${response.status}`)
  const result = (await response.json()) as AnthropicSubscriptionTokenResponse
  if (!result.access_token) throw new Error("Anthropic did not return an access token")
  return result
}

function credential(tokens: AnthropicSubscriptionTokenResponse, refresh: string, now: () => number) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: AnthropicSubscriptionMethodID,
    access: tokens.access_token,
    refresh,
    expires: now() + (tokens.expires_in ?? 3600) * 1000,
  })
}

async function generatePKCE(): Promise<Pkce> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(48)).buffer)
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function randomState() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

function base64UrlEncode(buffer: ArrayBuffer) {
  return Buffer.from(buffer).toString("base64url")
}
