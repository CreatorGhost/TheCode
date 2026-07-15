export * as Credential from "./credential"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Equal, Layer, Schema } from "effect"
import { Credential } from "@opencode-ai/schema/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CredentialTable } from "./credential/sql"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const Value = Credential.Value
export type Value = Credential.Value

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  value: Value,
}) {}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Replaces any credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Creates a credential only when the integration has no stored credential. */
  readonly createIfAbsent: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<{ readonly created: boolean; readonly credential: Info }>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /** Replaces an OAuth value only when it still matches the expected value. */
  readonly compareAndSetOAuth: (
    id: ID,
    expected: OAuth,
    value: OAuth,
  ) => Effect.Effect<{ readonly updated: boolean; readonly value: Value | undefined }>
  /** Removes a credential only when its value still matches the expected value. */
  readonly compareAndRemove: (
    id: ID,
    expected: Value,
  ) => Effect.Effect<{ readonly removed: boolean; readonly value: Value | undefined }>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Credential") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decode = Schema.decodeUnknownSync(Value)
    const decodePersisted = Schema.decodeUnknownSync(Schema.fromJsonString(Value))
    const persisted = (value: Value) => decodePersisted(JSON.stringify(value))
    const stored = (row: typeof CredentialTable.$inferSelect) => {
      if (!row.integration_id) return
      return new Info({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        value: decode(row.value),
      })
    }

    return Service.of({
      all: Effect.fn("Credential.all")(function* () {
        return (yield* db
          .select()
          .from(CredentialTable)
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      list: Effect.fn("Credential.list")(function* (integrationID) {
        return (yield* db
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.integration_id, integrationID))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      get: Effect.fn("Credential.get")(function* (id) {
        const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        return row ? stored(row) : undefined
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const credential = new Info({
          id: ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(CredentialTable)
                .where(eq(CredentialTable.integration_id, credential.integrationID))
                .run()
              yield* tx
                .insert(CredentialTable)
                .values({
                  id: credential.id,
                  integration_id: credential.integrationID,
                  label: credential.label,
                  value: credential.value,
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        return credential
      }),
      createIfAbsent: Effect.fn("Credential.createIfAbsent")(function* (input) {
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx
                  .select()
                  .from(CredentialTable)
                  .where(eq(CredentialTable.integration_id, input.integrationID))
                  .get()
                const current = row ? stored(row) : undefined
                if (current) return { created: false, credential: current }
                const credential = new Info({
                  id: ID.create(),
                  integrationID: input.integrationID,
                  label: input.label ?? "default",
                  value: input.value,
                })
                yield* tx
                  .insert(CredentialTable)
                  .values({
                    id: credential.id,
                    integration_id: credential.integrationID,
                    label: credential.label,
                    value: credential.value,
                  })
                  .run()
                return { created: true, credential }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        if (!updates.label && !updates.value) return
        yield* db
          .update(CredentialTable)
          .set({ label: updates.label, value: updates.value })
          .where(eq(CredentialTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }),
      compareAndSetOAuth: Effect.fn("Credential.compareAndSetOAuth")(function* (id, expected, value) {
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get()
                const current = row ? stored(row)?.value : undefined
                if (current?.type !== "oauth" || !Equal.equals(current, persisted(expected)))
                  return { updated: false, value: current }
                yield* tx.update(CredentialTable).set({ value }).where(eq(CredentialTable.id, id)).run()
                return { updated: true, value }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      compareAndRemove: Effect.fn("Credential.compareAndRemove")(function* (id, expected) {
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get()
                const current = row ? stored(row)?.value : undefined
                if (!Equal.equals(current, persisted(expected))) return { removed: false, value: current }
                yield* tx.delete(CredentialTable).where(eq(CredentialTable.id, id)).run()
                return { removed: true, value: undefined }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        yield* db.delete(CredentialTable).where(eq(CredentialTable.id, id)).run().pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
