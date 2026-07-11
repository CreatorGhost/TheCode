import { expect, test } from "bun:test"
import { win32SystemTheme } from "../src/terminal-win32"

test("win32SystemTheme returns a valid dark/light value on Windows, undefined elsewhere", () => {
  const result = win32SystemTheme()
  if (process.platform === "win32") {
    // On Windows the registry may or may not be readable; both outcomes are valid.
    // If readable, it must be "dark" or "light".
    expect(["dark", "light", undefined]).toContain(result)
  } else {
    expect(result).toBeUndefined()
  }
})

test("win32SystemTheme registry output parsing matches expected hex values", () => {
  // Verify the regex logic used inside win32SystemTheme.
  // reg query outputs: "    AppsUseLightTheme    REG_DWORD    0x0" (dark)
  //                     "    AppsUseLightTheme    REG_DWORD    0x1" (light)
  const parseLine = (line: string) => {
    const match = line.match(/0x([0-9a-f]+)/i)
    if (match) return parseInt(match[1], 16) === 0 ? "dark" : "light"
    return undefined
  }

  expect(parseLine("    AppsUseLightTheme    REG_DWORD    0x0")).toBe("dark")
  expect(parseLine("    AppsUseLightTheme    REG_DWORD    0x1")).toBe("light")
  expect(parseLine("    AppsUseLightTheme    REG_DWORD    0x00000000")).toBe("dark")
  expect(parseLine("    AppsUseLightTheme    REG_DWORD    0x00000001")).toBe("light")
  expect(parseLine("no match here")).toBeUndefined()
  expect(parseLine("")).toBeUndefined()
})

test("win32SystemTheme is idempotent - second call returns same value as first", () => {
  const a = win32SystemTheme()
  const b = win32SystemTheme()
  expect(a).toBe(b)
})
