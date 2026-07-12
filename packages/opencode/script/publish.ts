#!/usr/bin/env bun

// Publishes the DCode CLI to npm as an esbuild-style package: one thin wrapper
// (`dcode-ai`) plus a per-platform binary package for every build target
// (`dcode-ai-<os>-<arch>[-baseline][-musl]`). npm installs only the platform
// package matching the user's os/cpu, and the wrapper's bin/dcode shim execs it.
//
//   OPENCODE_VERSION=1.2.3 OPENCODE_CHANNEL=latest bun run script/publish.ts
//   bun run script/publish.ts --dry-run          # validate without publishing
//   bun run script/publish.ts --single --dry-run # build only the current platform
//
// Auth: npm publish reads ~/.npmrc (NODE_AUTH_TOKEN/NPM_TOKEN). --dry-run needs none.

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(__dirname, "..")
process.chdir(dir)

import { Script } from "@opencode-ai/script"
// Importing build.ts runs the full build (all targets) and returns the produced
// platform-package name -> version map. It uploads to GitHub Releases only when
// OPENCODE_RELEASE is set, which the npm publish flow deliberately leaves unset.
const { binaries } = await import("./build.ts")

const NPM_NAME = "dcode-ai"
const version = Script.version
const dryRun = process.argv.includes("--dry-run")
// Preview channels publish under their channel dist-tag so they never become the
// default `npm install dcode-ai`.
const tag = Script.channel === "latest" ? "latest" : Script.channel
const flags = ["--access", "public", "--tag", tag, ...(dryRun ? ["--dry-run"] : [])]

const names = Object.keys(binaries)
if (names.length === 0) throw new Error("build produced no binaries")

// Map each built target (dcode-<...>) to its published npm name (dcode-ai-<...>).
const npmNameFor = (built: string) => built.replace(/^dcode-/, `${NPM_NAME}-`)

const optionalDependencies: Record<string, string> = {}
for (const built of names) {
  const npmName = npmNameFor(built)
  const pkgDir = path.join(dir, "dist", built)
  const pkgJsonPath = path.join(pkgDir, "package.json")
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"))
  pkgJson.name = npmName
  pkgJson.description = `DCode CLI binary for ${pkgJson.os?.[0]} ${pkgJson.cpu?.[0]}`
  pkgJson.license = "MIT"
  pkgJson.repository = { type: "git", url: "git+https://github.com/CreatorGhost/TheCode.git" }
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2))
  console.log(`publishing ${npmName}@${version}`)
  await $`npm publish ${flags}`.cwd(pkgDir)
  optionalDependencies[npmName] = version
}

// Assemble the wrapper package from a clean generated manifest (the source
// package.json is private and carries workspace deps + raw TS exports).
const wrapperDir = path.join(dir, "dist", NPM_NAME)
fs.mkdirSync(path.join(wrapperDir, "bin"), { recursive: true })
fs.copyFileSync(path.join(dir, "bin", "dcode"), path.join(wrapperDir, "bin", "dcode"))
fs.chmodSync(path.join(wrapperDir, "bin", "dcode"), 0o755)

const readme = path.resolve(dir, "../../README.md")
if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(wrapperDir, "README.md"))

fs.writeFileSync(
  path.join(wrapperDir, "package.json"),
  JSON.stringify(
    {
      name: NPM_NAME,
      version,
      description: "DCode — an AI coding agent for the terminal (fork of opencode)",
      bin: { dcode: "./bin/dcode" },
      optionalDependencies,
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/CreatorGhost/TheCode.git" },
      homepage: "https://github.com/CreatorGhost/TheCode",
      bugs: { url: "https://github.com/CreatorGhost/TheCode/issues" },
      keywords: ["dcode", "opencode", "ai", "cli", "coding-agent", "terminal", "agent"],
      files: ["bin", "README.md"],
    },
    null,
    2,
  ),
)

console.log(`publishing ${NPM_NAME}@${version}`)
await $`npm publish ${flags}`.cwd(wrapperDir)

console.log(dryRun ? "dry run complete" : `published ${NPM_NAME}@${version} (${names.length} platform packages)`)
