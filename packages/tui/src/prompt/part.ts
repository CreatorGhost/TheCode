import { displaySlice } from "./display"

// Summarize only genuinely large pastes into a "[Pasted ~N lines]" placeholder.
// Short pastes, including dictated speech-to-text input (typically a sentence
// or two on a single line), must stay inline and editable.
const PASTE_SUMMARY_LINE_LIMIT = 10
const PASTE_SUMMARY_CHAR_LIMIT = 1000

export function shouldSummarizePaste(text: string) {
  const lines = (text.match(/\n/g)?.length ?? 0) + 1
  return lines > PASTE_SUMMARY_LINE_LIMIT || text.length > PASTE_SUMMARY_CHAR_LIMIT
}

export function stripPromptPartIDs<Part extends { id: string; messageID: string; sessionID: string }>(part: Part) {
  const { id: _id, messageID: _messageID, sessionID: _sessionID, ...rest } = part
  return rest
}

export function expandPastedTextPlaceholders(text: string, parts: readonly unknown[]) {
  return parts.reduce<string>((result, part) => {
    if (!isPastedTextPart(part)) return result
    return result.replace(part.source.text.value, part.text)
  }, text)
}

function isPastedTextPart(part: unknown): part is { type: "text"; text: string; source: { text: { value: string } } } {
  if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return false
  if (!("text" in part) || typeof part.text !== "string" || !("source" in part)) return false
  const source = part.source
  if (!source || typeof source !== "object" || !("text" in source)) return false
  const text = source.text
  return Boolean(text && typeof text === "object" && "value" in text && typeof text.value === "string")
}

export function expandTrackedPastedText(text: string, ranges: { start: number; end: number; text: string }[]) {
  return ranges
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce((result, part) => displaySlice(result, 0, part.start) + part.text + displaySlice(result, part.end), text)
}
