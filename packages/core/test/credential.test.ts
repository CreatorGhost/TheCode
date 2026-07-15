import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Credential.node))

describe("Credential", () => {
  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      const replacement = yield* credentials.create({
        integrationID,
        label: "Replacement",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("atomically replaces only the expected OAuth value", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("anthropic-subscription")
      const methodID = Integration.MethodID.make("claude-pro-max")
      const expected = Credential.OAuth.make({
        type: "oauth",
        methodID,
        access: "expired",
        refresh: "refresh-old",
        expires: 0,
        metadata: { account: "old", organization: "example", ignored: undefined },
      })
      const created = yield* credentials.create({ integrationID, value: expected })
      const reordered = Credential.OAuth.make({
        ...expected,
        metadata: { organization: "example", account: "old" },
      })
      const equivalent = Credential.OAuth.make({ ...expected, access: "equivalent" })
      expect(yield* credentials.compareAndSetOAuth(created.id, reordered, equivalent)).toEqual({
        updated: true,
        value: equivalent,
      })
      yield* credentials.update(created.id, { value: expected })
      const replacement = Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("replacement"),
        access: "replacement",
        refresh: "refresh-replacement",
        expires: 10,
        metadata: { account: "replacement" },
      })
      yield* credentials.update(created.id, { value: replacement })
      const refreshed = Credential.OAuth.make({
        type: "oauth",
        methodID,
        access: "refreshed",
        refresh: "refresh-new",
        expires: 20,
      })

      expect(yield* credentials.compareAndSetOAuth(created.id, expected, refreshed)).toEqual({
        updated: false,
        value: replacement,
      })
      expect((yield* credentials.get(created.id))?.value).toEqual(replacement)
      expect(yield* credentials.compareAndSetOAuth(created.id, replacement, refreshed)).toEqual({
        updated: true,
        value: refreshed,
      })
      expect((yield* credentials.get(created.id))?.value).toEqual(refreshed)

      const metadataChanged = Credential.OAuth.make({ ...expected, metadata: { account: "changed" } })
      yield* credentials.update(created.id, { value: metadataChanged })
      expect(yield* credentials.compareAndSetOAuth(created.id, expected, refreshed)).toEqual({
        updated: false,
        value: metadataChanged,
      })
      expect((yield* credentials.get(created.id))?.value).toEqual(metadataChanged)

      yield* credentials.update(created.id, { value: expected })
      const competing = Credential.OAuth.make({ ...refreshed, access: "competing" })
      const results = yield* Effect.all(
        [
          credentials.compareAndSetOAuth(created.id, expected, refreshed),
          credentials.compareAndSetOAuth(created.id, expected, competing),
        ],
        { concurrency: "unbounded" },
      )
      const current = (yield* credentials.get(created.id))?.value
      if (current?.type !== "oauth") throw new Error("Expected OAuth credential")
      expect([refreshed, competing]).toContainEqual(current)
      expect(results.map((result) => result.value)).toEqual([current, current])
      expect(results.filter((result) => result.updated)).toHaveLength(1)

      const key = Credential.Key.make({ type: "key", key: "replacement-key" })
      yield* credentials.update(created.id, { value: key })
      expect(yield* credentials.compareAndSetOAuth(created.id, expected, refreshed)).toEqual({
        updated: false,
        value: key,
      })
      yield* credentials.remove(created.id)
      expect(yield* credentials.compareAndSetOAuth(created.id, expected, refreshed)).toEqual({
        updated: false,
        value: undefined,
      })

      const first = yield* credentials.createIfAbsent({ integrationID, value: expected })
      expect(first.created).toBe(true)
      expect(yield* credentials.createIfAbsent({ integrationID, value: competing })).toEqual({
        created: false,
        credential: first.credential,
      })
      expect(yield* credentials.compareAndRemove(first.credential.id, refreshed)).toEqual({
        removed: false,
        value: expected,
      })
      expect(yield* credentials.compareAndRemove(first.credential.id, expected)).toEqual({
        removed: true,
        value: undefined,
      })
    }),
  )
})
