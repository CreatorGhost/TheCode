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
  // A transient network/DNS failure here must not escape publish()'s "never
  // throws" contract. Degrade to "not published" and let the publish attempt
  // proceed; a genuine duplicate is caught below via npm's "cannot publish over".
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}/${version}`)
    return res.ok
  } catch (error) {
    console.error(`failed to check ${name}@${version}; will attempt publish:`, error)
    return false
  }
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
    // A concurrent/earlier run (or a preflight that failed to detect the existing
    // version) already published this exact version: npm rejects the duplicate,
    // which is success for our purposes, not a failure.
    if (/cannot publish over/i.test(output)) {
      console.log(`skipping ${name}@${version} (already published)`)
      return true
    }
    const rateLimited = output.includes("E429") || /429 too many requests/i.test(output)
    if (!rateLimited) {
      console.error(`failed to publish ${name}:\n${output}`)
      return false
    }
    if (attempt === MAX_ATTEMPTS) {
      console.error(`npm rate limited ${name} after ${attempt} attempts; leaving it for a re-run`)
      return false
    }
    // Prefer a valid Retry-After (capped), else capped exponential backoff. Guard
    // against a Retry-After of 0, which would otherwise defeat the backoff.
    const retryAfter = parseRetryAfter(output)
    const delay =
      retryAfter && retryAfter > 0 ? Math.min(retryAfter, 300_000) : Math.min(90_000 * 2 ** (attempt - 1), 300_000)
    console.log(`npm rate limited ${name}; retrying in ${Math.round(delay / 1000)}s`)
    await Bun.sleep(delay)
  }
  return false
}

// Map each built target (dcode-<...>) to its published npm name (dcode-ai-<...>).
const npmNameFor = (built: string) => built.replace(/^dcode-/, `${NPM_NAME}-`)

const failures: string[] = []

// The wrapper's optional deps are fully determined by the build target list and
// do not depend on whether each platform publish succeeds, so compute them up
// front and publish the wrapper first.
const optionalDependencies: Record<string, string> = Object.fromEntries(
  names.map((built) => [npmNameFor(built), version]),
)

// Publish the wrapper FIRST. It is the only package users install
// (`npm i -g dcode-ai`). Publishing it before the large per-platform binaries
// means a later rate limit or CI timeout can leave a platform for a re-run
// without ever leaving `dcode-ai` itself unpublished — the exact failure that
// made the CLI un-installable. A platform that is briefly missing degrades to the
// shim's "install <pkg> manually" message and self-heals on the re-run.
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

if (!(await publish(wrapperDir, NPM_NAME))) failures.push(NPM_NAME)

// Then publish each per-platform binary package. npm resolves only the current
// platform's optional dep at install time, so any left for a re-run do not break
// installs on other platforms.
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
  if (!(await publish(pkgDir, npmName))) failures.push(npmName)
}

// Both real and dry-run modes must fail loudly if any package failed, so the
// workflow's validation-only mode can't green-light broken packages.
if (failures.length > 0) {
  console.error(
    `${dryRun ? "dry run" : "publish"} left these packages unpublished: ${failures.join(", ")}. ` +
      `Re-running this workflow with the same version publishes only the missing ones.`,
  )
  process.exit(1)
}
console.log(dryRun ? "dry run complete" : `published ${NPM_NAME}@${version} (${names.length} platform packages)`)
