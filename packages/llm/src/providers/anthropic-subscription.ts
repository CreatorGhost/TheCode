import { Effect, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { AnthropicMessages } from "../protocols/anthropic-messages"
import { Auth } from "../route/auth"
import { Route, type RouteDefaultsInput } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { HttpTransport, type Transport } from "../route/transport"
import { InvalidRequestReason, LLMError, ProviderID, type ModelID } from "../schema"

export const id = ProviderID.make("anthropic-subscription")
export const defaultClaudeCodeVersion = "2.1.185"
export const systemIdentity = "You are Claude Code, Anthropic's official CLI for Claude."

const billingSalt = "59cf53e54c78"
const toolPrefix = "mcp_"
const requiredBetas = ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14"]
const apiOrigin = "https://api.anthropic.com"

type ContentBlock = Record<string, unknown> & {
  type?: string
  text?: string
  name?: string
}

type Message = {
  role?: string
  content?: string | ContentBlock[]
}

type RequestBody = Record<string, unknown> & {
  system?: ContentBlock[]
  tools?: Array<Record<string, unknown> & { name?: string }>
  tool_choice?: Record<string, unknown> & { type?: string; name?: string }
  messages?: Message[]
}

export type Config = RouteDefaultsInput & {
  readonly accessToken: string
  readonly sessionID: string
  readonly baseURL?: string
  readonly claudeCodeVersion?: string
}

const prefixToolName = (name: string) => {
  if (name.startsWith(toolPrefix)) return name
  return `${toolPrefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

const toolNames = (tools: RequestBody["tools"]) => {
  const outbound = new Map<string, string>()
  const inbound = new Map<string, string>()
  for (const tool of tools ?? []) {
    if (!tool.name) continue
    const base = prefixToolName(tool.name)
    let encoded = base
    let suffix = 2
    while (inbound.has(encoded)) encoded = `${base}_${suffix++}`
    outbound.set(tool.name, encoded)
    inbound.set(encoded, tool.name)
  }
  return { outbound, inbound }
}

const firstUserText = (messages: Message[]) => {
  const content = messages.find((message) => message.role === "user")?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.find((block) => block.type === "text")?.text ?? ""
}

const hash = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

const billingHeader = async (messages: Message[], version: string) => {
  const text = firstUserText(messages)
  const sampled = [4, 7, 20].map((index) => text[index] ?? "0").join("")
  const suffix = (await hash(`${billingSalt}${sampled}${version}`)).slice(0, 3)
  const contentHash = (await hash(text)).slice(0, 5)
  return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=sdk-cli; cch=${contentHash};`
}

const transformBody = async (parsed: RequestBody, version: string): Promise<RequestBody> => {
  const system = Array.isArray(parsed.system) ? parsed.system : []
  const messages = Array.isArray(parsed.messages) ? parsed.messages.map((message) => ({ ...message })) : []
  const billing = await billingHeader(messages, version)
  const names = toolNames(parsed.tools)
  const moved = system.flatMap((item) => {
    if (item.type !== "text" || !item.text) return []
    const text = item.text.startsWith(systemIdentity)
      ? item.text.slice(systemIdentity.length).replace(/^\n+/, "")
      : item.text
    return text && !text.startsWith("x-anthropic-billing-header") ? [text] : []
  })
  const firstUser = messages.find((message) => message.role === "user")
  if (firstUser && moved.length > 0) {
    const text = moved.join("\n\n")
    if (typeof firstUser.content === "string") firstUser.content = `${text}\n\n${firstUser.content}`
    if (Array.isArray(firstUser.content)) firstUser.content = [{ type: "text", text }, ...firstUser.content]
    if (firstUser.content === undefined) firstUser.content = text
  }
  const transformedMessages = messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) => ({
          ...block,
          name:
            block.type === "tool_use" && block.name
              ? (names.outbound.get(block.name) ?? prefixToolName(block.name))
              : block.name,
        }))
      : message.content,
  }))
  const keptSystem = firstUser
    ? []
    : system.filter(
        (item) =>
          item.type !== "text" ||
          (!item.text?.startsWith(systemIdentity) && !item.text?.startsWith("x-anthropic-billing-header")),
      )
  return {
    ...parsed,
    system: [{ type: "text", text: billing }, { type: "text", text: systemIdentity }, ...keptSystem],
    messages: transformedMessages,
    tools: parsed.tools?.map((tool) => ({
      ...tool,
      name: tool.name ? (names.outbound.get(tool.name) ?? prefixToolName(tool.name)) : tool.name,
    })),
    tool_choice:
      parsed.tool_choice?.type === "tool" && parsed.tool_choice.name
        ? {
            ...parsed.tool_choice,
            name: names.outbound.get(parsed.tool_choice.name) ?? prefixToolName(parsed.tool_choice.name),
          }
        : parsed.tool_choice,
  }
}

export async function transformBodyText(body: string, version = defaultClaudeCodeVersion) {
  try {
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body
    return JSON.stringify(await transformBody(parsed as RequestBody, version))
  } catch {
    return body
  }
}

export const toolNameMap = (body: string): ReadonlyMap<string, string> => {
  try {
    const parsed = JSON.parse(body) as RequestBody
    return toolNames(parsed.tools).inbound
  } catch {
    return new Map()
  }
}

export const restoreToolNames = (frame: string, names?: ReadonlyMap<string, string>) =>
  frame.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, (match, name: string) => {
    const restored = names?.get(`mcp_${name}`)
    return restored === undefined ? match : `"name":${JSON.stringify(restored)}`
  })

const transport = (version: string) => {
  const base = HttpTransport.sseJson.with<AnthropicMessages.AnthropicMessagesBody>()
  type Prepared = {
    readonly http: HttpTransport.HttpPrepared<string>
    readonly toolNames: ReadonlyMap<string, string>
  }
  return {
    id: "http-json/sse/anthropic-subscription",
    prepare: (input: Parameters<typeof base.prepare>[0]) => {
      const bodyText = input.encodeBody(input.body)
      const toolNames = toolNameMap(bodyText)
      return Effect.promise(async () => JSON.parse(await transformBodyText(bodyText, version))).pipe(
        Effect.flatMap((body) => base.prepare({ ...input, body })),
        Effect.map((http) => ({ http, toolNames })),
      )
    },
    frames: (prepared: Prepared, request, runtime) =>
      base
        .frames(prepared.http, request, runtime)
        .pipe(Stream.map((frame) => restoreToolNames(frame, prepared.toolNames))),
  } satisfies Transport<AnthropicMessages.AnthropicMessagesBody, Prepared, string>
}

const authentication = (input: Config, version: string) =>
  Auth.custom((request) => {
    if (new URL(request.url).origin !== apiOrigin) {
      return Effect.fail(
        new LLMError({
          module: "AnthropicSubscription",
          method: "authenticate",
          reason: new InvalidRequestReason({ message: "Claude subscription credentials require api.anthropic.com" }),
        }),
      )
    }
    const existing = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "anthropic-beta")?.[1]
    const betas = new Set(
      (existing ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    )
    requiredBetas.forEach((beta) => betas.add(beta))
    return Effect.succeed(
      Headers.setAll(Headers.remove(request.headers, "x-api-key"), {
        authorization: `Bearer ${input.accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": [...betas].join(","),
        "anthropic-dangerous-direct-browser-access": "true",
        "x-app": "cli",
        "x-client-request-id": crypto.randomUUID(),
        "x-claude-code-session-id": input.sessionID,
        "user-agent": `claude-cli/${version} (external, sdk-cli)`,
      }),
    )
  })

const configuredRoute = (input: Config) => {
  const version = input.claudeCodeVersion ?? defaultClaudeCodeVersion
  const { accessToken: _, sessionID: __, baseURL, claudeCodeVersion: ___, ...defaults } = input
  return Route.make({
    id: "anthropic-subscription",
    provider: id,
    protocol: AnthropicMessages.protocol,
    endpoint: Endpoint.path(AnthropicMessages.PATH, {
      baseURL: baseURL ?? AnthropicMessages.DEFAULT_BASE_URL,
      query: { beta: "true" },
    }),
    auth: authentication(input, version),
    transport: transport(version),
    defaults,
  })
}

export const configure = (input: Config) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model({ id: modelID }),
    configure,
  }
}

export const provider = { id, configure }
