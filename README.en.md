# dsh-vault

[中文](README.md) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin that keeps every conversation and log **inside the workspace folder**, so
the folder becomes a self-contained, portable archive.

When `dsh-vault` is installed, each workspace folder gains a
`dsh-session-vault/` directory:

```
my-project/
  dsh-session-vault/
    workspace.json          # the workspace title (name) + a vault marker
    sessions/
      <session-id>.jsonl    # one append-only conversation log per session
```

- Every session whose `cwd` is the workspace is mirrored into
  `dsh-session-vault/sessions/` as it happens.
- The workspace title is cached in `dsh-session-vault/workspace.json`.

## Why this works on a new computer

1. Copy the workspace folder (the whole directory, including the
   `dsh-session-vault/`) to the new computer.
2. Install DSH and this plugin there.
3. Open the copied folder as a workspace.

On open, `dsh-vault` imports every session from the vault back into DSH
persistence (rebinding each session's `cwd` to the folder's current location),
and restores the workspace name from `workspace.json`. All conversations —
including the workspace title — come back.

## Install

### DeepSeek Harness Desktop

Add the plugin in the desktop app's plugin manager using a GitHub spec — not the
package name:

```
github:XiaoWind/dsh-vault
```

The desktop app runs `pnpm add github:XiaoWind/dsh-vault` in its profile
directory, resolves the latest commit on the default branch, and adds the
package to `dsh.profile.bundles` once compatibility passes. **Restart the
desktop app when prompted** for the plugin to take effect.

> **The `github:owner/repo` spec is required.** This plugin is not published to
> the npm registry, so a bare `dsh-vault` would be looked up on npm and the
> installation would fail.

> Before installing, the desktop runtime checks every `@deepseek-ai/dsh-*` peer
> range against the running version (the `dsh-app-boot` version, for example
> `0.2.0-rc.2`). An incompatible plugin is refused and `package.json`,
> `pnpm-lock.yaml`, and `node_modules` are rolled back — update the plugin in
> that case.

### CLI / Web

```sh
# from GitHub (works immediately — no npm publish required)
dsh plugin --profile web add github:XiaoWind/dsh-vault

# equivalent form
dsh plugin --profile web add git+https://github.com/XiaoWind/dsh-vault.git
```

`dsh plugin` forwards to `pnpm` inside the `web` profile directory, then
reconciles the profile's `dsh.profile.bundles` layer list. Because this package
declares `dsh.bundle.patch`, it joins the layer stack automatically. Restart the
Web app after installing.

> The plugin injects `sessionPersistence`, `workspaceRegistry`, and `commands`,
> so it activates only in profiles that compose those host services — the
> shipped `web` profile does.

## Update

**Desktop**: reinstall the plugin from the plugin manager, or remove it and add
`github:XiaoWind/dsh-vault` again. pnpm may have cached an old git resolution,
so removing and re-adding is the most reliable path. Restart the desktop app
afterwards.

**CLI / Web**:

```sh
dsh plugin --profile web update dsh-vault
```

`dsh plugin` forwards to `pnpm update dsh-vault`, which re-resolves the
`github:XiaoWind/dsh-vault` dependency to the latest commit on the default
branch. The lockfile pins a git dependency by commit hash, so a `version` bump
is not required for the update to land. If pnpm has cached an old resolution,
re-pin it explicitly:

```sh
dsh plugin --profile web add github:XiaoWind/dsh-vault
```

Restart the app after updating — the bundle layer is composed at boot, so a
running process does not hot-reload an installed plugin.

## Usage

The vault runs automatically — no setup required. A `/vault` slash command
provides visibility and manual control:

| Command | Result |
|---|---|
| `/vault status` | Show vaulted workspaces and per-workspace session counts. |
| `/vault restore` | Import vaulted sessions/titles for known workspaces now. |
| `/vault export` | (Re)write vault files from current persistence now. |
| `/vault help` | Show help. |

### How it behaves

- **Continuous mirroring.** As a session appends events, they are written to
  the workspace's `dsh-session-vault/sessions/<id>.jsonl` in order. On session
  disposal the file is rewritten as a clean snapshot.
- **Automatic restore.** At boot, and whenever a workspace is opened, the
  plugin imports any vault session missing from DSH persistence and applies the
  vaulted title. On a brand-new machine, opening the copied folder as a
  workspace triggers the same restore.
- **Portable paths.** Session `cwd`s are rebound to the workspace's current
  absolute path on import, so a folder copied to a different location restores
  cleanly.
- **Idempotent.** Sessions already in persistence are never re-imported, and
  attaching/renaming is a no-op when nothing changed.

## Configuration

No configuration is required. The plugin inserts with an empty `config`; the
vault directory name (`dsh-session-vault`) and the JSONL format are fixed so
vaults stay interchangeable across machines.

Each vault's `workspace.json` also carries a `kind: "dsh-vault"` marker, so the
plugin recognizes a vault by its content rather than relying on the directory
name alone.

## Development

```sh
# syntax check
node --check lib/index.js
node --check lib/vault.js
```

The plugin is dependency-free ESM (`lib/index.js` + `lib/vault.js`) with no
build step. It exports `apply`, `inject`, and `name`, and the bundle layer
`cordis.patch.yml` inserts it into the profile composition. The JSONL format is
self-contained and independent of the harness, so `lib/vault.js` can be
unit-tested directly.

## License

MIT
