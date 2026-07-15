#!/usr/bin/env bun

// Publishes the DCode CLI to npm as an esbuild-style package: one thin wrapper
// (`dcode-ai`) plus a per-platform binary package for every build target
// (`dcode-ai-<os>-<arch>[-baseline][-musl]`). npm installs only the platform
// package matching the user's os/cpu, and the wrapper's bin/dcode shim resolves
// and execs it at runtime (pure optionalDependencies, no postinstall step). If a
// platform's optional dependency fails to install, the shim prints the exact
// package name to install manually.
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
const single = process.argv.includes("--single")
// Preview channels publish under their channel dist-tag so they never become the
// default `npm install dcode-ai`.
const tag = Script.channel === "latest" ? "latest" : Script.channel
const flags = ["--access", "public", "--tag", tag, ...(dryRun ? ["--dry-run"] : [])]

// A real publish must build every platform (a --single wrapper would only install
// on one OS/arch) and carry an explicit version (never the 0.0.0 fallback).
if (!dryRun && single) throw new Error("--single builds one platform; it is only valid with --dry-run")
if (!dryRun && !process.env["OPENCODE_VERSION"]) throw new Error("set OPENCODE_VERSION for a real publish")

const names = Object.keys(binaries)
if (names.length === 0) throw new Error("build produced no binaries")

// npm forbids republishing an existing version. Skip already-published packages so
// a re-run after a partial failure is idempotent instead of 403-aborting.
const alreadyPublished = async (name: string) => {
  if (dryRun) return false
  const res = await fetch(`https://registry.npmjs.org/${name}/${version}`)
  return res.ok
}
const MAX_ATTEMPTS = 8

// Honor an explicit Retry-After when npm surfaces one, else back off exponentially.
const parseRetryAfter = (output: string) => {
  const match = output.match(/retry-after:\s*(\d+)/i)
  if (!match) return undefined
  const seconds = Number(match[1])
  return Number.isFinite(seconds) ? seconds * 1000 : undefined
}

// Publishes one package. Returns true on success (or already-published), false on
// failure. It never throws: a single platform's npm publish rate limit (E429 on
// the large Windows binaries) must not abort the run before the tiny user-facing
// wrapper is published. Failed packages are collected and reported, and a re-run
// fills them idempotently via the already-published skip above.
const publish = async (pkgDir: string, name: string): Promise<boolean> => {
  if (await alreadyPublished(name)) {
    console.log(`skipping ${name}@${version} (already published)`)
    return true
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`publishing ${name}@${version}${attempt > 1 ? ` (attempt ${attempt}/${MAX_ATTEMPTS})` : ""}`)
    const result = await $`npm publish ${flags}`.cwd(pkgDir).quiet().nothrow()
    if (result.exitCode === 0) return true
    const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`
    if (!output.includes("E429")) {
      console.error(`failed to publish ${name}:\n${output}`)
      return false
    }
    if (attempt === MAX_ATTEMPTS) {
      console.error(`npm rate limited ${name} after ${attempt} attempts; leaving it for a re-run`)
      return false
    }
    const delay = parseRetryAfter(output) ?? Math.min(attempt * 90_000, 300_000)
    console.log(`npm rate limited ${name}; retrying in ${Math.round(delay / 1000)}s`)
    await Bun.sleep(delay)
  }
  return false
}

// Map each built target (dcode-<...>) to its published npm name (dcode-ai-<...>).
const npmNameFor = (built: string) => built.replace(/^dcode-/, `${NPM_NAME}-`)

const failures: string[] = []
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
  // Always declare the platform dep at this version: npm only resolves the
  // current platform's optional dep at install time, so listing one that is still
  // rate limited is harmless, and a later re-run that publishes it makes it
  // available without needing to touch the already-published wrapper.
  optionalDependencies[npmName] = version
  if (!(await publish(pkgDir, npmName))) failures.push(npmName)
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
      bin: { dcode: "bin/dcode" },
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

// Always publish the wrapper, even if some platform binaries were rate limited.
// The wrapper is a few hundred KB and never hits E429; gating it on every platform
// (one 184MB Windows binary that npm throttles) is exactly what left `dcode-ai`
// unpublished and un-installable before.
if (!(await publish(wrapperDir, NPM_NAME))) failures.push(NPM_NAME)

if (dryRun) {
  console.log("dry run complete")
} else if (failures.length > 0) {
  console.error(
    `published what it could, but these packages were left for a re-run: ${failures.join(", ")}. ` +
      `Re-running this workflow with the same version publishes only the missing ones.`,
  )
  process.exit(1)
} else {
  console.log(`published ${NPM_NAME}@${version} (${names.length} platform packages)`)
}
