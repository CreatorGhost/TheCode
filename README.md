# DCode

DCode is an open source AI coding agent built as a compatibility-focused fork of
[OpenCode](https://github.com/anomalyco/opencode).

The product name and executable are `DCode` and `dcode`. Existing OpenCode
configuration remains compatible, so DCode continues to use `opencode.json`,
`.opencode/`, `OPENCODE_*` environment variables, and the existing OpenCode
config, state, cache, and data directories.

## Installation

### Build From Source

```bash
git clone https://github.com/CreatorGhost/TheCode
cd TheCode
bun install
bun run --cwd packages/opencode build --single
./install --binary packages/opencode/dist/dcode-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')/bin/dcode
```

The build output is written to `packages/opencode/dist/dcode-<os>-<arch>/bin/dcode`.

### GitHub Releases

Once a release is available, install the latest build with:

```bash
curl -fsSL https://raw.githubusercontent.com/CreatorGhost/TheCode/dev/install | bash
```

The installer writes the executable to `~/.dcode/bin` by default. It supports
`DCODE_INSTALL_DIR`, the legacy `OPENCODE_INSTALL_DIR`, and `XDG_BIN_DIR` in that
order. DCode releases are published at
[CreatorGhost/TheCode](https://github.com/CreatorGhost/TheCode/releases).

DCode is not currently distributed through npm, Homebrew, Chocolatey, Scoop,
Arch, Nix, or desktop app stores. Packages named `opencode` or `opencode-ai` in
those channels install upstream OpenCode, not DCode.

## Usage

```bash
cd <project>
dcode
```

DCode includes the same built-in agents and configuration model as its OpenCode
base. Until fork-specific documentation is published, the
[upstream OpenCode documentation](https://opencode.ai/docs) remains applicable
to compatible configuration and provider features.

Automatic updates are disabled unless `autoupdate` is explicitly enabled in
your existing OpenCode-compatible configuration. Manual updates use
`dcode upgrade` and only install releases from `CreatorGhost/TheCode`.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for repository setup and contribution
guidance. Run package tests and type checks from their package directories, as
described in [AGENTS.md](./AGENTS.md).

## Attribution

DCode is based on OpenCode and preserves compatibility identifiers where
renaming them would break users, plugins, configurations, databases, or hosted
services. OpenCode Zen, OpenCode Go, `opencode.ai`, and related hosted services
remain upstream OpenCode products.

This fork is maintained independently and is not affiliated with the OpenCode
team.
