# Runtime Subagent Model Selection

## Purpose

Allow a parent agent to choose the model for each subagent invocation at runtime instead of requiring one statically configured agent per model.

The resolved model must identify both the provider and the provider-scoped model. A Task invocation may use either a canonical `provider/model` reference or a human-facing selector that resolves to exactly one usable canonical reference. A marketing name or version such as `5.6` must never silently select between multiple billing or credential routes.

## Example

A parent agent may launch the same general-purpose subagent twice with different models:

```json
{
  "description": "Fable independent review",
  "prompt": "Review the proposed change without editing files.",
  "subagent_type": "general",
  "model": "anthropic/claude-fable-5"
}
```

```json
{
  "description": "Terra independent review",
  "prompt": "Review the proposed change without editing files.",
  "subagent_type": "general",
  "model": "openai/gpt-5.6-terra"
}
```

These invocations may run concurrently. Each child Session records and displays its own resolved provider and model.

## Model Identity

The domain identity is `ModelV2.Ref`, containing at least `providerID` and provider-scoped model `id`. The model-facing Task input may encode that reference as the existing canonical `provider/model` string.

Examples of distinct routes include:

```text
openai/gpt-5.6-terra
amazon-bedrock/<bedrock-model-id>
azure/<deployment-id>
openrouter/openai/<openrouter-model-id>
```

Even when two routes advertise the same model family or marketing version, they remain different selections. The provider determines endpoint configuration, credentials, policy, availability, accounting metadata, and where usage is billed.

The following inputs are selectors rather than model identities:

```text
5.6
GPT 5.6
Terra
latest
```

OpenCode may accept a selector when normalized token matching against usable model IDs, names, families, provider-qualified names, and configured aliases produces exactly one canonical reference. Number words may normalize to digits, so `Fable five` can match `Fable 5`. If no route matches, selection fails with canonical suggestions. If multiple routes match, selection fails with `AmbiguousModelSelectorError` and the parent agent asks the user which provider route they intend.

OpenCode must not choose among multiple matches using:

- A display name, family, or version substring.
- Which provider was most recently used.
- Credential availability or provider ordering.
- The parent Session's provider when the request names only a model family.
- An arbitrary first match from the Catalog.

## Task Input

The Task tool accepts an optional runtime model reference:

```ts
interface TaskInput {
  description: string
  prompt: string
  subagent_type: string
  model?: string
  variant?: string
  task_id?: string
  command?: string
  background?: boolean
}
```

`model` accepts a canonical `provider/model` reference or a human-facing selector. It resolves to a `ModelV2.Ref` before child execution. Internally, code passes the structured reference rather than repeatedly parsing strings.

The Task tool also accepts an optional `variant`. Variant selection remains separate from model identity and is validated against the resolved model. Natural-language requests such as "high reasoning" should be represented as `variant: "high"` when that variant exists.

When the user names multiple subagent models in one request, the parent should issue one Task call per model and may launch independent calls concurrently. It should preserve the user's model wording in each `model` field unless it already knows the canonical reference.

## Resolution

For a new child task, resolve the model in this order:

1. The Task invocation's explicit `model`.
2. The selected subagent's configured model.
3. The parent provider turn's exact provider and model.

There is no fallback after an explicit selection fails. An unavailable, unknown, disabled, unauthorized, or incompatible explicit model fails the Task invocation before creating provider work.

For a resumed task:

- An explicit `model` switches subsequent child provider turns to that exact reference.
- An omitted `model` preserves the child Session's current model.
- The child must not drift to the parent's current model merely because the parent switched models after the child was created.
- Existing native continuation metadata follows the compatibility rules for model/provider switches.

## Provider And Credential Route

Resolution uses the Catalog and normal provider policy. It must verify:

- The provider exists and is usable.
- The provider is allowed by `provider.use` policy.
- The model exists under that provider and is enabled.
- The provider has a supported endpoint and usable authentication/configuration.
- The model supports the tools required by the selected subagent.

The child Session and Task metadata expose safe route information:

```ts
interface ResolvedTaskModel {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  variant?: ModelV2.VariantID
  authVia?: "env" | "account" | "custom"
  authService?: string
}
```

This information lets the user distinguish, for example, an OpenAI account/OAuth route from AWS Bedrock or Azure. Metadata must never include access tokens, API keys, account secrets, or raw custom-provider credential data.

The UI should present at least:

```text
General · openai/gpt-5.6-terra · account
General · amazon-bedrock/<model-id> · env
```

Provider-qualified identity remains authoritative even if authentication provenance is unavailable.

## Ambiguity And Errors

Expected selection failures are explicit and model-visible:

- `InvalidModelReferenceError`: input is not a canonical provider/model reference.
- `ProviderNotFoundError`: the provider ID is unknown.
- `ModelNotFoundError`: the model is unknown for that provider.
- `ProviderUnavailableError`: the provider lacks a usable endpoint or authentication route.
- `ProviderDeniedError`: policy denies use of the provider.
- `ModelUnavailableError`: the model exists but is disabled or unavailable.
- `ModelCapabilityError`: the selected model cannot support the subagent's required tools or input types.
- `AmbiguousModelAliasError`: an explicitly configured alias maps to more than one reference.
- `AmbiguousModelSelectorError`: a human-facing selector matches more than one usable canonical reference.

Errors should suggest canonical available references without silently retrying another provider. Suggestions must be filtered through provider policy and model availability.

## Permissions

Existing Task permission checks continue to govern the selected `subagent_type`. Runtime model selection additionally passes through provider policy and Catalog availability checks.

Permission metadata should include the requested canonical model reference so approval surfaces can show both execution identity and provider route. Saved permission rules remain agent-oriented unless a separate model/provider permission design is introduced; Task approval must not bypass `provider.use` policy.

## Concurrency

Multiple Task calls may select different models and execute concurrently. Model resolution is invocation-local and must not mutate:

- The parent Session's selected model.
- The subagent's static configuration.
- Global provider defaults.
- Another concurrent child Session.

Parallel children may share normal Location-scoped provider and Catalog services. Their durable messages, costs, usage, cancellation, background status, and completion metadata remain isolated by child Session.

## Observability

Every Task settlement records:

- Requested canonical model reference, when supplied.
- Resolved provider and model.
- Resolved variant, when present.
- Safe authentication provenance when available.
- Child Session ID.
- Whether execution was foreground or background.

Usage and cost attribution use the resolved provider/model route, not a family-level display name. Logs and diagnostics must make provider selection visible without exposing credentials.

## Compatibility

The new field is optional. Existing Task calls without `model` preserve current behavior for new children: configured subagent model first, then parent provider-turn model.

Existing statically model-pinned agents remain supported. An invocation-level explicit model intentionally overrides the static model for that child invocation.

Plugins observing `tool.execute.before` and `tool.execute.after` receive the optional canonical `model` field. A plugin may reject or rewrite it before execution, but the final value must still pass normal Catalog and policy resolution.

## Non-Goals

- Guessing a provider when a marketing model name matches multiple usable routes.
- Combining provider fallback, load balancing, or cheapest-route selection with explicit model selection.
- Moving credentials between providers.
- Treating AWS Bedrock, Azure, OpenRouter, and direct vendor access as interchangeable.
- Creating one generated agent configuration per available model.
- Allowing a model override to bypass provider policy or capability checks.

## Acceptance Criteria

1. A Task call can run `general` with `anthropic/claude-fable-5` while its parent uses another model.
2. Two parallel Task calls can run the same subagent type with different provider-qualified models.
3. `openai/gpt-5.6-terra` uses the configured OpenAI route and never silently resolves to Bedrock, Azure, or OpenRouter.
4. A provider-qualified Bedrock or Azure reference uses that provider's configuration even when another provider exposes the same model family.
5. A human-facing selector that matches exactly one usable route resolves to that canonical reference.
6. A selector that matches both a direct subscription and Bedrock fails with `AmbiguousModelSelectorError` and lists both canonical routes.
7. An explicit unavailable model fails without falling back to the agent model or parent model.
8. Omitting `model` for a new task preserves the existing configured-agent and parent-model fallback.
9. Resuming a child without `model` preserves the child's current model after the parent switches models.
10. Resuming with an explicit different model applies the switch and follows continuation-metadata compatibility rules.
11. Provider policy denial fails before a provider request is made.
12. Task and child Session metadata show the resolved provider/model and safe auth provenance.
13. No credential value appears in Task metadata, logs, errors, or UI output.
14. Cost and usage are attributed to the actual resolved provider/model route.
15. Existing Task clients remain compatible because the new fields are optional.

## Implementation Surface

The first implementation should update:

- Task input schema and model-facing description.
- Task execution model resolution.
- Child Session model persistence and resume behavior.
- Provider/Catalog validation and typed failure translation.
- Task permission metadata.
- Foreground and background Task metadata.
- CLI/TUI Task presentation.
- Tool parameter tests, Task execution tests, resume tests, provider-policy tests, and concurrent mixed-model tests.

If the Task input is part of a generated public contract, regenerate clients from the authoritative schema rather than editing generated files directly.
