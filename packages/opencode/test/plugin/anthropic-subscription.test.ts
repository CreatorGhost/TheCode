import { describe, expect, test } from "bun:test"
import { AnthropicSubscriptionAuthPlugin, PROVIDER_ID } from "../../src/plugin/anthropic/subscription"
import { withSyntheticProviders } from "../../src/provider/provider"

const oauth = {
  type: "oauth" as const,
  refresh: "refresh-token",
  access: "access-token",
  expires: 4_000_000,
}

const input = (set: (value: typeof oauth) => void = () => {}) =>
  ({
    client: {
      auth: {
        async set(value: { body: typeof oauth }) {
          set(value.body)
        },
      },
    },
  }) as never

describe("plugin.anthropic-subscription", () => {
  test("validates OAuth state before exchanging the authorization code", async () => {
    const exchanges: Request[] = []
    const hooks = await AnthropicSubscriptionAuthPlugin(input(), {
      authorizationOrigin: "https://login.test",
      tokenEndpoint: "https://tokens.test/oauth/token",
      now: () => 1_000,
      async fetch(request, init) {
        exchanges.push(new Request(request, init))
        return Response.json({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3600,
        })
      },
    })
    const method = hooks.auth!.methods[0]
    if (method.type !== "oauth") throw new Error("expected OAuth method")
    const authorization = await method.authorize()
    const url = new URL(authorization.url)
    const state = url.searchParams.get("state")

    expect(url.origin).toBe("https://login.test")
    expect(url.pathname).toBe("/oauth/authorize")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("scope")).toBe("org:create_api_key user:profile user:inference")
    expect(state).toBeTruthy()
    if (authorization.method !== "code") throw new Error("expected code callback")

    expect(await authorization.callback("code#wrong-state")).toEqual({ type: "failed" })
    expect(exchanges).toHaveLength(0)

    expect(await authorization.callback(`code#${state}`)).toEqual({
      type: "success",
      access: "access-new",
      refresh: "refresh-new",
      expires: 3_601_000,
    })
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0].headers.get("anthropic-beta")).toBe("oauth-2025-04-20")
    expect(await exchanges[0].json()).toMatchObject({
      code: "code",
      state,
      grant_type: "authorization_code",
    })
  })

  test("rewrites native session requests for Claude subscription auth", async () => {
    const requests: Request[] = []
    const hooks = await AnthropicSubscriptionAuthPlugin(input(), {
      apiOrigin: "https://api.test",
      now: () => 1_000,
      claudeCodeVersion: "2.1.185",
      async fetch(request, init) {
        requests.push(new Request(request, init))
        return new Response('data: {"content_block":{"type":"tool_use","name":"mcp_Bash"}}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })
    const loaded = await hooks.auth!.loader!(async () => oauth as never, {} as never)
    const response = await loaded.fetch!("https://api.test/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-beta": "existing-beta",
        "x-api-key": "must-not-leak",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        system: [
          {
            type: "text",
            text: "You are Claude Code, Anthropic's official CLI for Claude.\n\nDCode session instructions",
          },
        ],
        tools: [{ name: "bash" }],
        messages: [
          { role: "user", content: [{ type: "text", text: "Fix the test" }] },
          { role: "assistant", content: [{ type: "tool_use", name: "read" }] },
        ],
      }),
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe("https://api.test/v1/messages?beta=true")
    expect(requests[0].headers.get("authorization")).toBe("Bearer access-token")
    expect(requests[0].headers.has("x-api-key")).toBe(false)
    expect(requests[0].headers.get("anthropic-beta")).toContain("oauth-2025-04-20")
    expect(requests[0].headers.get("anthropic-beta")).toContain("existing-beta")
    expect(requests[0].headers.get("x-app")).toBe("cli")
    expect(requests[0].headers.get("x-claude-code-session-id")).toBeTruthy()

    const body = (await requests[0].json()) as {
      system: Array<{ text: string }>
      tools: Array<{ name: string }>
      messages: Array<{ content: Array<{ text?: string; name?: string }> }>
    }
    expect(body.system).toHaveLength(2)
    expect(body.system[0].text).toStartWith("x-anthropic-billing-header:")
    expect(body.system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.")
    expect(body.messages[0].content[0].text).toBe("DCode session instructions")
    expect(body.tools[0].name).toBe("mcp_Bash")
    expect(body.messages[1].content[0].name).toBe("mcp_Read")
    expect(await response.text()).toContain('"name":"bash"')

    await expect(loaded.fetch!("https://attacker.test/v1/messages")).rejects.toThrow(
      "Anthropic subscription credentials cannot be sent to this origin",
    )
    expect(requests).toHaveLength(1)
  })

  test("deduplicates concurrent refreshes and persists rotated tokens", async () => {
    let auth = { ...oauth, access: "", expires: 0 }
    const updates: Array<typeof oauth> = []
    const durable: Array<Omit<typeof oauth, "type"> & { expectedRefresh: string }> = []
    const authorizations: Array<string | null> = []
    let refreshRequests = 0
    let releaseRefresh: (() => void) | undefined
    const refreshReady = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const hooks = await AnthropicSubscriptionAuthPlugin(
      input((value) => {
        updates.push(value)
        auth = value
      }),
      {
        apiOrigin: "https://api.test",
        tokenEndpoint: "https://tokens.test/oauth/token",
        now: () => 1_000,
        async persist(value) {
          durable.push(value)
        },
        async fetch(request, init) {
          const current = new Request(request, init)
          if (current.url === "https://tokens.test/oauth/token") {
            refreshRequests += 1
            await refreshReady
            return Response.json({
              access_token: "access-new",
              refresh_token: "refresh-new",
              expires_in: 3600,
            })
          }
          authorizations.push(current.headers.get("authorization"))
          return new Response("{}")
        },
      },
    )
    const loaded = await hooks.auth!.loader!(async () => auth as never, {} as never)
    const body = JSON.stringify({ messages: [{ role: "user", content: "hello" }] })
    const first = loaded.fetch!("https://api.test/v1/messages", { method: "POST", body })
    const second = loaded.fetch!("https://api.test/v1/messages", { method: "POST", body })

    await waitFor(() => refreshRequests === 1)
    expect(authorizations).toHaveLength(0)
    releaseRefresh!()
    await Promise.all([first, second])

    expect(refreshRequests).toBe(1)
    expect(updates).toEqual([])
    expect(authorizations).toEqual(["Bearer access-new", "Bearer access-new"])
    expect(durable).toEqual([
      {
        access: "access-new",
        refresh: "refresh-new",
        expires: 3_601_000,
        expectedRefresh: "refresh-token",
      },
      {
        access: "access-new",
        refresh: "refresh-new",
        expires: 3_601_000,
        expectedRefresh: "refresh-token",
      },
    ])
  })

  test("retries a staggered 401 with the already-rotated durable token", async () => {
    const latest = { ...oauth, access: "access-new", refresh: "refresh-new" }
    const authorizations: Array<string | null> = []
    let reads = 0
    let refreshes = 0
    const hooks = await AnthropicSubscriptionAuthPlugin(input(), {
      apiOrigin: "https://api.test",
      tokenEndpoint: "https://tokens.test/oauth/token",
      now: () => 1_000,
      async fetch(request, init) {
        const current = new Request(request, init)
        if (current.url === "https://tokens.test/oauth/token") {
          refreshes += 1
          return Response.json({ access_token: "unexpected", refresh_token: "unexpected", expires_in: 3600 })
        }
        authorizations.push(current.headers.get("authorization"))
        return new Response("{}", { status: authorizations.length === 1 ? 401 : 200 })
      },
    })
    const loaded = await hooks.auth!.loader!(async () => (reads++ < 2 ? oauth : latest) as never, {} as never)

    await loaded.fetch!("https://api.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    })

    expect(refreshes).toBe(0)
    expect(authorizations).toEqual(["Bearer access-token", "Bearer access-new"])
  })

  test("handles credentials removed during loader initialization and requests", async () => {
    const hooks = await AnthropicSubscriptionAuthPlugin(input(), { apiOrigin: "https://api.test" })
    expect(await hooks.auth!.loader!(async () => undefined as never, {} as never)).toEqual({})
    let reads = 0
    const loaded = await hooks.auth!.loader!(async () => (reads++ === 0 ? oauth : undefined) as never, {} as never)

    await expect(loaded.fetch!("https://api.test/v1/messages")).rejects.toThrow(
      "Anthropic subscription is disconnected",
    )
  })

  test("exposes only Claude models at zero metered cost", async () => {
    const hooks = await AnthropicSubscriptionAuthPlugin(input())
    const models = await hooks.provider!.models!(
      {
        models: {
          claude: {
            api: { id: "claude-sonnet-4-6" },
            cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
          },
          other: {
            api: { id: "not-claude" },
            cost: { input: 1, output: 1, cache: { read: 1, write: 1 } },
          },
        },
      } as never,
      { auth: oauth as never },
    )

    expect(Object.keys(models)).toEqual(["claude"])
    expect(models.claude.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })

    const output = { system: ["DCode session instructions"] }
    await hooks["experimental.chat.system.transform"]!({ model: { providerID: PROVIDER_ID } } as never, output as never)
    expect(output.system[0]).toBe("You are Claude Code, Anthropic's official CLI for Claude.")
  })

  test("clones the Anthropic catalog under a separate provider identity", () => {
    const anthropic = {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      models: { claude: { id: "claude-sonnet-4-6" } },
    }
    const providers = withSyntheticProviders({ anthropic } as never)

    expect(providers.anthropic.id).toBe("anthropic")
    expect(providers[PROVIDER_ID]).toMatchObject({
      id: PROVIDER_ID,
      name: "Claude Pro/Max",
      env: [],
      models: anthropic.models,
    })
  })
})

async function waitFor(predicate: () => boolean) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
