import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import {
  AnthropicSubscriptionMethodID,
  AnthropicSubscriptionProviderID,
} from "@opencode-ai/core/plugin/provider/anthropic-subscription"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionRunnerLLM } from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "./lib/effect"

const requests: Array<{ url: string; headers: Headers; body: string }> = []
const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      requests.push({ url: web.url, headers: web.headers, body: yield* Effect.promise(() => web.text()) })
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          [
            { type: "message_start", message: { usage: { input_tokens: 7 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from Claude." } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
            { type: "message_stop" },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    }),
  ),
)
const executor = RequestExecutor.layer.pipe(Layer.provide(http))
const client = LLMClient.layer.pipe(Layer.provide(executor))
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const catalogModel = ModelV2.Info.make({
  ...ModelV2.Info.empty(AnthropicSubscriptionProviderID, ModelV2.ID.make("claude-sonnet-test")),
  name: "Claude Sonnet Test",
  api: {
    id: ModelV2.ID.make("claude-sonnet-test"),
    type: "aisdk",
    package: "@ai-sdk/anthropic",
    url: "https://api.anthropic.com/v1",
  },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: { "x-api-key": "must-not-leak" }, body: {} },
  limit: { context: 200_000, output: 8_192 },
})
const oauth = Credential.OAuth.make({
  type: "oauth",
  methodID: AnthropicSubscriptionMethodID,
  access: "oauth-access",
  refresh: "oauth-refresh",
  expires: Date.now() + 3_600_000,
})
const models = SessionRunnerModel.layerWith((session) =>
  SessionRunnerModel.fromCatalogModel(catalogModel, oauth, session.id),
)
const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [Config.node, config],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const runner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => runner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      ToolRegistry.node,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Config.node, config],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
    ],
  ),
)

describe("SessionRunner Anthropic subscription", () => {
  it.effect("runs one durable prompt through the subscription transport", () =>
    Effect.gen(function* () {
      requests.length = 0
      const sessionID = SessionV2.ID.make("ses_anthropic_subscription")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const sessions = yield* SessionV2.Service
      yield* sessions.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Say hello in one short sentence." }),
        resume: false,
      })

      yield* sessions.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0].url).toBe("https://api.anthropic.com/v1/messages?beta=true")
      expect(requests[0].headers.get("authorization")).toBe("Bearer oauth-access")
      expect(requests[0].headers.get("x-api-key")).toBeNull()
      expect(requests[0].headers.get("x-claude-code-session-id")).toBe(sessionID)
      const body = JSON.parse(requests[0].body) as {
        system: Array<{ text: string }>
        messages: Array<{ role: string; content: Array<{ text?: string }> }>
      }
      expect(body.system[0].text).toStartWith("x-anthropic-billing-header:")
      expect(body.system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.")
      expect(body.messages[0].content.some((part) => part.text === "Say hello in one short sentence.")).toBeTrue()
      const context = yield* sessions.context(sessionID)
      const last = context.at(-1)
      expect(last).toMatchObject({ type: "assistant", finish: "stop" })
      expect(last?.type === "assistant" ? last.content : []).toMatchObject([
        { type: "text", text: "Hello from Claude." },
      ])
    }),
  )
})
