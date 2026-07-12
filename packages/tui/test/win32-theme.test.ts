import { expect, test } from "bun:test"
import { parseWin32Theme, win32SystemTheme } from "../src/terminal-win32"

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

test("parseWin32Theme parses AppsUseLightTheme DWORD from reg output", () => {
  const key = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"
  expect(parseWin32Theme(`${key}\r\n    AppsUseLightTheme    REG_DWORD    0x0\r\n`)).toBe("dark")
  expect(parseWin32Theme(`${key}\r\n    AppsUseLightTheme    REG_DWORD    0x1\r\n`)).toBe("light")
  expect(parseWin32Theme("    AppsUseLightTheme    REG_DWORD    0x00000000")).toBe("dark")
  expect(parseWin32Theme("    AppsUseLightTheme    REG_DWORD    0x00000001")).toBe("light")
  expect(parseWin32Theme("no match here")).toBeUndefined()
  expect(parseWin32Theme("")).toBeUndefined()
  // Anchored: a stray hex token that is NOT the AppsUseLightTheme value is ignored.
  expect(parseWin32Theme("SomeOtherValue    REG_DWORD    0x1\r\n(no AppsUseLightTheme line)")).toBeUndefined()
})

test("win32SystemTheme is idempotent - second call returns same value as first", () => {
  const a = win32SystemTheme()
  const b = win32SystemTheme()
  expect(a).toBe(b)
})
