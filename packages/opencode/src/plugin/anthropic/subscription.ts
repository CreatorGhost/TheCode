import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import {
  defaultClaudeCodeVersion,
  restoreToolNames,
  systemIdentity,
  toolNameMap,
  transformBodyText,
} from "@opencode-ai/llm/providers/anthropic-subscription"
import { OAUTH_DUMMY_KEY } from "../../auth"
import { Credential } from "@opencode-ai/core/credential"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import {
  AnthropicSubscriptionIntegrationID,
  AnthropicSubscriptionMethodID,
  refreshAnthropicSubscriptionToken,
} from "@opencode-ai/core/plugin/provider/anthropic-subscription"
import { Effect } from "effect"
import { withAnthropicSubscriptionCredentialLock } from "../../provider/anthropic-subscription-credential"

export const PROVIDER_ID = "anthropic-subscription"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZATION_ORIGIN = "https://claude.ai"
const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token"
const API_ORIGIN = "https://api.anthropic.com"
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
const REFRESH_MARGIN = 5 * 60 * 1000
const REQUIRED_BETAS = ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14"]
const credentialLayer = AppNodeBuilder.build(Credential.node)

interface Options {
  authorizationOrigin?: string
  tokenEndpoint?: string
  apiOrigin?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  now?: () => number
  claudeCodeVersion?: string
  persist?: (value: { access: string; refresh: string; expires: number; expectedRefresh: string }) => Promise<void>
}

interface Pkce {
  verifier: string
  challenge: string
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

function persistDurable(value: { access: string; refresh: string; expires: number; expectedRefresh: string }) {
  return Effect.runPromise(
    withAnthropicSubscriptionCredentialLock(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const current = (yield* credentials.list(AnthropicSubscriptionIntegrationID)).at(-1)
        const { expectedRefresh: _, ...tokens } = value
        const credential = Credential.OAuth.make({
          type: "oauth",
          methodID: AnthropicSubscriptionMethodID,
          ...tokens,
        })
        if (current?.value.type === "oauth" && current.value.refresh === value.expectedRefresh) {
          yield* credentials.update(current.id, { value: credential })
          return
        }
        if (
          current?.value.type === "oauth" &&
          current.value.access === value.access &&
          current.value.refresh === value.refresh
        )
          return
        return yield* Effect.die("Anthropic subscription is disconnected")
      }),
    ).pipe(Effect.provide(credentialLayer)),
  )
}

function base64UrlEncode(buffer: ArrayBuffer) {
  return Buffer.from(buffer).toString("base64url")
}

async function generatePKCE(): Promise<Pkce> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(48)).buffer)
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function randomState() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

function transformResponse(response: Response, names: ReadonlyMap<string, string>) {
  if (!response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${restoreToolNames(line, names)}\n`))
        }
      },
      flush(controller) {
        pending += decoder.decode()
        if (pending) controller.enqueue(encoder.encode(restoreToolNames(pending, names)))
      },
    }),
  )
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export async function AnthropicSubscriptionAuthPlugin(input: PluginInput, options: Options = {}): Promise<Hooks> {
  const authorizationOrigin = options.authorizationOrigin ?? AUTHORIZATION_ORIGIN
  const tokenEndpoint = options.tokenEndpoint ?? TOKEN_ENDPOINT
  const apiOrigin = options.apiOrigin ?? API_ORIGIN
  const request = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const persist = options.persist ?? persistDurable
  const claudeCodeVersion = options.claudeCodeVersion ?? process.env.ANTHROPIC_CLI_VERSION ?? defaultClaudeCodeVersion
  const sessionID = randomUUID()

  async function exchange(code: string, verifier: string, state: string) {
    const [authorizationCode, returnedState] = code.trim().split("#")
    if (!authorizationCode || returnedState !== state) return { type: "failed" as const }
    const response = await request(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" },
      body: JSON.stringify({
        code: authorizationCode,
        state: returnedState,
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    })
    if (!response.ok) return { type: "failed" as const }
    const token = (await response.json()) as TokenResponse
    if (!token.access_token || !token.refresh_token) return { type: "failed" as const }
    return {
      type: "success" as const,
      access: token.access_token,
      refresh: token.refresh_token,
      expires: now() + (token.expires_in ?? 3600) * 1000,
    }
  }

  return {
    "experimental.chat.system.transform": async (context, output) => {
      if (context.model?.providerID !== PROVIDER_ID) return
      if (!output.system.some((item) => item.includes(systemIdentity))) output.system.unshift(systemIdentity)
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, context) {
        if (context.auth?.type !== "oauth") return provider.models
        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => model.api.id.startsWith("claude-"))
            .map(([id, model]) => [
              id,
              {
                ...model,
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
              },
            ]),
        )
      },
    },
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth) {
        const initial = await getAuth()
        if (initial?.type !== "oauth") return {}

        const refresh = (refreshToken: string) =>
          refreshAnthropicSubscriptionToken({
            refresh: refreshToken,
            request,
            tokenEndpoint,
          }).then(async (token) => {
            if (!token.access_token) throw new Error("Anthropic subscription expired; reconnect with /connect")
            const updated = {
              access: token.access_token,
              refresh: token.refresh_token ?? refreshToken,
              expires: now() + (token.expires_in ?? 3600) * 1000,
            }
            await persist({ ...updated, expectedRefresh: refreshToken })
            return updated
          })

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const original = new Request(requestInput, init)
            const url = new URL(original.url)
            if (url.origin !== apiOrigin)
              throw new Error("Anthropic subscription credentials cannot be sent to this origin")

            const auth = await getAuth()
            if (auth?.type !== "oauth")
              throw new Error("Anthropic subscription is disconnected; reconnect with /connect")
            if (!auth.access || auth.expires <= now() + REFRESH_MARGIN) {
              const refreshed = await refresh(auth.refresh)
              auth.access = refreshed.access
              auth.refresh = refreshed.refresh
              auth.expires = refreshed.expires
            }

            if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) url.searchParams.set("beta", "true")
            const originalBody = original.body ? await original.clone().text() : undefined
            const names = toolNameMap(originalBody ?? "")
            const body = originalBody ? await transformBodyText(originalBody, claudeCodeVersion) : undefined
            const send = (access: string) => {
              const headers = new Headers(original.headers)
              const beta = new Set(
                (headers.get("anthropic-beta") ?? "")
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              )
              for (const required of REQUIRED_BETAS) beta.add(required)
              headers.delete("x-api-key")
              headers.set("authorization", `Bearer ${access}`)
              headers.set("anthropic-version", headers.get("anthropic-version") ?? "2023-06-01")
              headers.set("anthropic-beta", [...beta].join(","))
              headers.set("anthropic-dangerous-direct-browser-access", "true")
              headers.set("x-app", "cli")
              headers.set("x-client-request-id", randomUUID())
              headers.set("x-claude-code-session-id", sessionID)
              headers.set("user-agent", `claude-cli/${claudeCodeVersion} (external, sdk-cli)`)
              return request(url, {
                method: original.method,
                headers,
                body,
                signal: original.signal,
                redirect: original.redirect,
              })
            }
            let response = await send(auth.access)
            if (response.status === 401) {
              response.body?.cancel().catch(() => {})
              const latest = await getAuth()
              if (latest?.type !== "oauth") {
                throw new Error("Anthropic subscription is disconnected; reconnect with /connect")
              }
              if (latest.access && latest.access !== auth.access) {
                response = await send(latest.access)
              } else {
                const refreshed = await refresh(latest.refresh)
                response = await send(refreshed.access)
              }
            }
            return transformResponse(response, names)
          },
        }
      },
      methods: [
        {
          label: "Claude Pro/Max subscription",
          type: "oauth",
          authorize: async () => {
            const pkce = await generatePKCE()
            const state = randomState()
            const url = new URL("/oauth/authorize", authorizationOrigin)
            url.searchParams.set("code", "true")
            url.searchParams.set("client_id", CLIENT_ID)
            url.searchParams.set("response_type", "code")
            url.searchParams.set("redirect_uri", REDIRECT_URI)
            url.searchParams.set("scope", "org:create_api_key user:profile user:inference")
            url.searchParams.set("code_challenge", pkce.challenge)
            url.searchParams.set("code_challenge_method", "S256")
            url.searchParams.set("state", state)
            return {
              url: url.toString(),
              instructions: "Paste the authorization code here:",
              method: "code" as const,
              callback: (code: string) => exchange(code, pkce.verifier, state),
            }
          },
        },
      ],
    },
  }
}
