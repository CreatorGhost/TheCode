import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const BAR_WIDTH = 24

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  const bar = createMemo(() => {
    const filled = Math.min(BAR_WIDTH, Math.round(((state().percent ?? 0) / 100) * BAR_WIDTH))
    return { filled, rest: BAR_WIDTH - filled }
  })

  return (
    <box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().textMuted}>CONTEXT</text>
        <text fg={theme().primary}>{state().percent ?? 0}%</text>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().textMuted}>tokens</text>
        <text fg={theme().text}>{state().tokens.toLocaleString()}</text>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().textMuted}>spent</text>
        <text fg={theme().text}>{money.format(cost())}</text>
      </box>
      <text>
        <span style={{ fg: theme().primary }}>{"━".repeat(bar().filled)}</span>
        <span style={{ fg: theme().backgroundElement }}>{"━".repeat(bar().rest)}</span>
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
