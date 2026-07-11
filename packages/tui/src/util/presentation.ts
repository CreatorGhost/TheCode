import { logo } from "../logo"

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"
const white = "\x1b[97m"
const green = "\x1b[38;2;0;230;118m"

function wordmark(pad = "") {
  return logo.left.map(
    (line, index) => `${pad}${bold}${white}${line}${reset} ${bold}${green}${logo.right[index] ?? ""}${reset}`,
  )
}

export function sessionEpilogue(input: { title: string; sessionID?: string }) {
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  return [
    ...wordmark("  "),
    `  ${green}━━━━━━━━${reset}`,
    "",
    `  ${weak("Session")}${bold}${input.title}${reset}`,
    `  ${weak("Continue")}${bold}dcode -s ${input.sessionID}${reset}`,
    "",
  ].join("\n")
}
