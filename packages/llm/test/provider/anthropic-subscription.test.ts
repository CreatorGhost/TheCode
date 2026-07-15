import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message } from "../../src"
import { AnthropicSubscription } from "../../src/providers"
import { LLMClient } from "../../src/route"
import { dynamicResponse } from "../lib/http"
import { it } from "../lib/effect"
import { sseEvents } from "../lib/sse"

describe("Anthropic subscription provider", () => {
  it.effect("rewrites requests and restores streamed tool names", () =>
    Effect.gen(function* () {
      expect(AnthropicSubscription.restoreToolNames('{"name":"mcp_ServerTool"}', new Map())).toBe(
        '{"name":"mcp_ServerTool"}',
      )
      const model = AnthropicSubscription.configure({
        accessToken: "oauth-access",
        sessionID: "session-123",
        claudeCodeVersion: "2.1.185",
        baseURL: "https://api.anthropic.com/v1",
        headers: { "anthropic-beta": "existing-beta", "x-api-key": "must-not-leak" },
      }).model("claude-sonnet-test")
      const response = yield* LLMClient.generate(
        LLM.request({
          model,
          system: "DCode session instructions",
          messages: [
            Message.user("Run the tool"),
            Message.assistant({ type: "tool-call", id: "old", name: "read", input: {} }),
            Message.tool({ id: "old", name: "read", result: "ok", resultType: "text" }),
          ],
          tools: [
            { name: "bash", description: "Run a command", inputSchema: { type: "object" } },
            { name: "mcp_probe", description: "Probe", inputSchema: { type: "object" } },
            { name: "URLFetch", description: "Fetch a URL", inputSchema: { type: "object" } },
            { name: "mcp_URLFetch", description: "Fetch through MCP", inputSchema: { type: "object" } },
            { name: "mcp_Foo_3", description: "Pre-suffixed Foo", inputSchema: { type: "object" } },
            { name: "Foo", description: "Uppercase Foo", inputSchema: { type: "object" } },
            { name: "foo", description: "Lowercase foo", inputSchema: { type: "object" } },
          ],
          toolChoice: { type: "tool", name: "bash" },
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              expect(input.request.url).toBe("https://api.anthropic.com/v1/messages?beta=true")
              expect(input.request.headers.authorization).toBe("Bearer oauth-access")
              expect(input.request.headers["x-api-key"]).toBeUndefined()
              expect(input.request.headers["anthropic-beta"]).toContain("existing-beta")
              expect(input.request.headers["anthropic-beta"]).toContain("oauth-2025-04-20")
              expect(input.request.headers["x-claude-code-session-id"]).toBe("session-123")
              const body = JSON.parse(input.text) as {
                system: Array<{ text: string }>
                messages: Array<{ role: string; content: Array<{ type: string; text?: string; name?: string }> }>
                tools: Array<{ name: string }>
                tool_choice: { name: string }
              }
              expect(body.system).toHaveLength(2)
              expect(body.system[0].text).toStartWith("x-anthropic-billing-header:")
              expect(body.system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.")
              expect(body.messages[0].content[0].text).toBe("DCode session instructions")
              expect(body.messages[1].content[0].name).toBe("mcp_Read")
              expect(body.tools.map((tool) => tool.name)).toEqual([
                "mcp_Bash",
                "mcp_probe",
                "mcp_URLFetch",
                "mcp_URLFetch_2",
                "mcp_Foo_3",
                "mcp_Foo",
                "mcp_Foo_2",
              ])
              expect(body.tool_choice.name).toBe("mcp_Bash")
              return input.respond(
                sseEvents(
                  { type: "message_start", message: { usage: { input_tokens: 5 } } },
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "tool_use", id: "call_1", name: "mcp_probe" },
                  },
                  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
                  { type: "content_block_stop", index: 0 },
                  {
                    type: "content_block_start",
                    index: 1,
                    content_block: { type: "tool_use", id: "call_2", name: "mcp_URLFetch" },
                  },
                  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
                  { type: "content_block_stop", index: 1 },
                  {
                    type: "content_block_start",
                    index: 2,
                    content_block: { type: "tool_use", id: "call_3", name: "mcp_URLFetch_2" },
                  },
                  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
                  { type: "content_block_stop", index: 2 },
                  {
                    type: "content_block_start",
                    index: 3,
                    content_block: { type: "tool_use", id: "call_4", name: "mcp_Foo_2" },
                  },
                  { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{}" } },
                  { type: "content_block_stop", index: 3 },
                  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
                  { type: "message_stop" },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "mcp_probe", input: {} }),
          expect.objectContaining({ name: "URLFetch", input: {} }),
          expect.objectContaining({ name: "mcp_URLFetch", input: {} }),
          expect.objectContaining({ name: "foo", input: {} }),
        ]),
      )
    }),
  )

  it.effect("rejects non-Anthropic API origins before applying OAuth credentials", () =>
    Effect.gen(function* () {
      const model = AnthropicSubscription.configure({
        accessToken: "oauth-access",
        sessionID: "session-123",
        baseURL: "https://proxy.example/v1",
      }).model("claude-sonnet-test")
      const failure = yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(dynamicResponse((input) => Effect.succeed(input.respond("")))),
        Effect.flip,
      )

      expect(failure.message).toContain("Claude subscription credentials require api.anthropic.com")
    }),
  )
})
