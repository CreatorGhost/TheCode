import { describe, expect, test } from "bun:test"
import { expandTrackedPastedText, shouldSummarizePaste, stripPromptPartIDs } from "../../src/prompt/part"

describe("prompt part", () => {
  test("strips persisted IDs from reused parts", () => {
    expect(
      stripPromptPartIDs({
        id: "prt_old",
        sessionID: "ses_old",
        messageID: "msg_old",
        type: "file" as const,
        mime: "image/png",
        filename: "tiny.png",
        url: "data:image/png;base64,abc",
      }),
    ).toEqual({
      type: "file",
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    })
  })

  test("preserves wide characters around pasted text", () => {
    const marker = "[Pasted ~3 lines]"
    const prefix = "你好你好\n"

    expect(
      expandTrackedPastedText(prefix + marker + "\n阿斯顿法国红酒看来", [
        {
          start: Bun.stringWidth("你好你好") + 1,
          end: Bun.stringWidth("你好你好") + 1 + Bun.stringWidth(marker),
          text: "public:\n\tvoid ExecuteTask();\nprivate:",
        },
      ]),
    ).toBe("你好你好\npublic:\n\tvoid ExecuteTask();\nprivate:\n阿斯顿法国红酒看来")
  })

  test("keeps short pastes inline", () => {
    expect(shouldSummarizePaste("a short sentence")).toBe(false)
    expect(shouldSummarizePaste("one\ntwo\nthree\nfour lines")).toBe(false)
    // dictated speech-to-text sized input: a paragraph on a single line
    expect(shouldSummarizePaste("word ".repeat(150).trim())).toBe(false)
    // boundary: exactly at the limits stays inline
    expect(shouldSummarizePaste(Array.from({ length: 10 }, () => "line").join("\n"))).toBe(false)
    expect(shouldSummarizePaste("x".repeat(1000))).toBe(false)
  })

  test("summarizes genuinely large pastes", () => {
    expect(shouldSummarizePaste("x".repeat(1001))).toBe(true)
    expect(shouldSummarizePaste(Array.from({ length: 11 }, () => "line").join("\n"))).toBe(true)
    expect(shouldSummarizePaste("log line\n".repeat(200))).toBe(true)
  })

  test("only expands the tracked placeholder occurrence", () => {
    const marker = "[Pasted ~3 lines]"
    const prefix = `keep ${marker} then `

    expect(
      expandTrackedPastedText(prefix + marker + " tail", [
        {
          start: Bun.stringWidth(prefix),
          end: Bun.stringWidth(prefix + marker),
          text: "alpha\nbeta\ngamma",
        },
      ]),
    ).toBe(`keep ${marker} then alpha\nbeta\ngamma tail`)
  })
})
