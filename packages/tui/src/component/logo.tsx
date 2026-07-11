import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { useDirectory } from "../context/directory"
import { logo } from "../logo"

export function Logo() {
  const { theme } = useTheme()
  const directory = useDirectory()

  return (
    <box>
      <For each={logo.left}>
        {(line, index) => (
          <box flexDirection="row" gap={1}>
            <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
              {line}
            </text>
            <text fg={theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
              {logo.right[index()]}
            </text>
          </box>
        )}
      </For>
      <box paddingTop={1} gap={1}>
        <text fg={theme.primary} selectable={false}>
          ━━━━━━━━
        </text>
        <box>
          <text fg={theme.textMuted} selectable={false}>
            decode runs commands on your behalf to help you build.
          </text>
          <text fg={theme.textMuted} selectable={false}>
            Directory <span style={{ fg: theme.text, bold: true }}>{directory()}</span>
          </text>
        </box>
      </box>
    </box>
  )
}
