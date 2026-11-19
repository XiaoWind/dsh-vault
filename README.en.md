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
- **Headers are stored as the host gives them.** A vault record's header carries
  exactly the fields the running session format uses (format v4 requires
  `isSeeded` and refuses the long-retired `seedLength`), so the plugin neither
  drops fields nor invents them as the host format evolves.
- **Automatic restore.** At boot, and whenever a workspace is opened, the
  plugin imports any vault session missing from DSH persistence and applies the
  vaulted title. On a brand-new machine, opening the copied folder as a
  workspace triggers the same restore.
- **Portable paths.** Session `cwd`s are rebound to the workspace's current
  absolute path on import, so a folder copied to a different location restores
  cleanly.
- **Idempotent.** Sessions already in persistence are never re-imported, and
  attaching/renaming is a no-op when nothing changed.
- **Records repair themselves.** The plugin only mirrors events while it is
  running, so a session that keeps appending while the plugin is unloaded
  (switching runtimes, reinstalling the plugin) leaves a hole in its record.
  Re-opening that session makes the plugin compare the file with the full log
  in memory and fill the file in; session disposal also writes a complete
  snapshot. `/vault export` force-rewrites every vault file from current
  persistence, which repairs anything at any time.
- **A record is only ever extended, never shortened.** The plugin rewrites a
  record only when it can read the session's complete log; when no log is
  readable it merely creates a missing header and leaves the record alone. Every
  rewrite — **including `/vault export`** — first checks that the new log covers
  the record's **highest** `seq`, not just its last line: a log can end with a
  line from an older generation or a sync merge, and judging by the last line
  alone misreads the record's length (that is how 0.1.8 replaced a 1587-event
  record with 52 events on 2026-11-19). When a shrink is possible and the record
  is larger than what would replace it, the plugin scans the record for its true
  maximum `seq` and refuses the write with a warning if the new log stops short.
  To deliberately accept a shorter persisted log, delete that `<id>.jsonl`
  first, then run `/vault export` to rebuild it.
- **Empty shells repair themselves.** When a record holds only a header while
  DSH persistence still holds that session's content (judged by the stored
  artifact's size), the boot export rewrites the whole record from persistence.
  Records wiped by that regression come back on the next start without manual
  intervention.
- **An incomplete record recovers what it can.** A durable DSH log must be a
  contiguous run of `seq` values starting at 0.
  - **Missing head** (the record starts at `seq 6`): the events before it have no
    source, and renumbering a later event as 0 would rewrite history, so the
    whole record is skipped with the reason in the log
    (`its log starts at seq 6`).
  - **Hole after an intact head**: the plugin imports the contiguous **prefix**
    before the hole and lets the session end there — the same shape a crashed
    session has — while logging how many later events are unreachable
    (`restoring session "…" up to seq 1078: 2 later event(s) are unreachable
    because its log has a hole`). One lost event no longer costs the whole
    conversation.
  - For a complete record, run `/vault export` on the origin machine (rewrites
    from persistence), or reopen the session so the plugin repairs it, then copy
    the folder again.
- **A stored session that exists but is shorter is checked.** Restore only imports
  sessions persistence is *missing*, and "exists" is not "is complete": a
  conversation continued on another machine (the workspace folder syncs through
  Syncthing/OneDrive, so the vault record arrives, while `~/.dsh/sessions` stays
  machine-local) or a log cut short by a crash leaves a short session that
  shadows the vault forever. At boot and on `/vault restore` the plugin compares
  the two:
  - **The stored log is a true prefix of the record**: the record's remaining
    contiguous events are **appended**, so the conversation becomes complete
    again (an `info` line reports how many events were added).
  - **The stored log diverged** (a later event disagrees — a resume marker or
    another command sits where the record has conversation): nothing is merged,
    because appending old history after newer events would fabricate an order
    that never happened. A warning names the session, both sizes and the remedy —
    `session "…" holds 49 of 1587 vaulted event(s) but diverged at seq 40, so it
    cannot be extended; delete this session in DSH and run /vault restore to
    rebuild it from the vault` — and `/vault restore` reports how many sessions
    need rebuilding.
  - So the boot pass stays cheap, the comparison is gated on the stored artifact
    being far smaller than the record (about 8×); `/vault restore` compares every
    session regardless.
- **Missing image attachments are marked offloaded.** The vault mirrors session
  logs, **not attachment bytes** (images are content addressed under
  `<DSH_HOME>/attachments/v1/objects/`). A conversation copied to another machine
  keeps its image references but not their bytes, and the host resolves every
  referenced image before it builds a request — so a missing object fails *every*
  turn with the unrelated `DeepSeek Messages transport failed`. On session entry
  the plugin detects the gap and appends one `image/offload` event, DSH's own way
  to represent an image that cannot be sent, which the projection turns into text.
  The conversation becomes usable again; only those images are gone. Reopen the
  session (or restart the app) to trigger the repair.

  > Known boundary: **images and attachments do not travel with the vault.** Copy
  > `<DSH_HOME>/attachments/v1` alongside the workspace folder when they must be
  > preserved.

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
