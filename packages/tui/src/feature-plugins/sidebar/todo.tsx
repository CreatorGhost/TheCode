import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"
import { TodoItem } from "../../component/todo-item"

const id = "internal:sidebar-todo"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  const show = createMemo(() => list().length > 0 && list().some((item) => item.status !== "completed"))
  const done = createMemo(() => list().filter((item) => item.status === "completed").length)

  return (
    <Show when={show()}>
      <box>
        <box
          flexDirection="row"
          gap={1}
          justifyContent="space-between"
          onMouseDown={() => list().length > 2 && setOpen((x) => !x)}
        >
          <box flexDirection="row" gap={1}>
            <Show when={list().length > 2}>
              <text fg={theme().textMuted}>{open() ? "▼" : "▶"}</text>
            </Show>
            <text fg={theme().textMuted}>TODOS</text>
          </box>
          <text fg={theme().primary}>
            {done()}/{list().length}
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>{(item) => <TodoItem status={item.status} content={item.content} />}</For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
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
