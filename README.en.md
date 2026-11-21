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
github:XiaoWind/dsh-vault#<40-char commit sha>
```

**Pin the full 40-character commit.** DSH's plugin manager only reports
`update: 'git'` (and allows a hot update) for a git source pinned to a full
commit; that pin is also what the runtime auto-update below needs. A plain
`github:XiaoWind/dsh-vault` spec still installs, but auto-update stays off.

The desktop app runs `pnpm add` in its profile directory, checks this package's
`engines.dsh` (`>=0.2.2-rc.5 <0.3.0`) against the running DSH version, and adds
the package to `dsh.profile.bundles` once it passes. An incompatible plugin is
refused and `package.json`, `pnpm-lock.yaml`, and `node_modules` are rolled
back. **Restart the desktop app when prompted** for the plugin to take effect.

> **The `github:owner/repo` spec is required.** This plugin is not published to
> the npm registry, so a bare `dsh-vault` would be looked up on npm and the
> installation would fail.

### CLI / Web

```sh
# from GitHub, pinned to a full commit (required for auto-update)
dsh plugin --profile web add "github:XiaoWind/dsh-vault#<40-char commit sha>"

# or install from the default branch (auto-update stays off)
dsh plugin --profile web add github:XiaoWind/dsh-vault
```

`dsh plugin` forwards to `pnpm` inside the `web` profile directory, then
reconciles the profile's `dsh.profile.bundles` layer list. Because this package
declares `dsh.bundle.patch`, it joins the layer stack automatically. Restart the
Web app after installing.

> The plugin injects `sessionPersistence`, `workspaceRegistry`, and `commands`,
> so it activates only in profiles that compose those host services — the
> shipped `web` profile does.

## Auto-update

The plugin updates itself at runtime, no external script required:

1. About 90 seconds after start — then every 6 hours — it checks the latest
   commit on GitHub for `XiaoWind/dsh-vault`;
2. it reads that commit's `package.json` and only updates when `version` is
   newer than the running one;
3. it hot-updates the installed plugin to that commit through the DSH plugin
   manager (a git spec pinned to the 40-char sha). Profiles with HMR enabled —
   including the desktop app — remove and reload the plugin in place, no restart
   needed;
4. success or failure is reported as a session notice; a failure leaves the
   running version untouched and the next check retries.

A failed lookup (network error, HTTP error, or an unreadable `package.json`) is
retried after 15 minutes; a failed install waits for the next check and is
reported with a notice.

**Prerequisite**: the plugin must be installed with a full-commit spec (see
Install). A non-pinned install never auto-updates; `/vault update` tells you how
to reinstall.

An update only replaces plugin code — it **never touches vault files**; records
under `dsh-session-vault/` stay exactly as they are.

Tune it in the profile's `cordis.patch.yml`:

```yaml
- id: vault
  config:
    autoUpdate: true                 # false disables the checks
    updateCheckIntervalMs: 21600000  # between checks (default 6 hours)
    updateInitialDelayMs: 90000      # first check (default 90 seconds)
```

Set `DSH_PLUGIN_AUTO_UPDATE=0` to disable auto-update for all plugins. Checks
try `api.github.com` (contents API) first, then fall back to `raw.githubusercontent.com` and `cdn.jsdelivr.net`; set `GITHUB_TOKEN` if you
hit unauthenticated rate limits. Trigger a check manually with `/vault update`.

### Manual update (when auto-update is off)

**Desktop**: remove the plugin in the plugin manager and add it again with a
pinned spec; restart the app afterwards.

**CLI / Web**:

```sh
dsh plugin --profile web update dsh-vault
# or pin a specific commit explicitly
dsh plugin --profile web add "github:XiaoWind/dsh-vault#<new commit sha>"
```

Restart the app after updating — the bundle layer is composed at boot, so a
running process does not hot-reload an installed plugin unless HMR is enabled.

## Usage

The vault runs automatically — no setup required. A `/vault` slash command
provides visibility and manual control:

| Command | Result |
|---|---|
| `/vault status` | Show vaulted workspaces and per-workspace session counts. |
| `/vault restore` | Import vaulted sessions/titles for known workspaces now. |
| `/vault export` | (Re)write vault files from current persistence now. |
| `/vault update` | Check for a plugin update now. |
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
- **A restored session is never left archived.** Archiving is registry-global: it
  hides a session from every list while keeping its workspace slot. The plugin
  lifts an imported session out of the archive set, and an explicit
  `/vault restore` also lifts vaulted sessions that already exist — otherwise a
  successful restore looks exactly like nothing happening. The boot pass only
  touches sessions it imports, so a deliberate archive is never silently undone.
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
- **Image attachments are recovered from identical workspace files first.** An
  attachment id is the sha256 of the image bytes, so any file in the workspace with
  exactly those bytes *is* that image — the path and file name are irrelevant. When
  restoring or opening a session the plugin scans the workspace for images (depth 6,
  at most 4000 files, size-filtered before hashing) and copies a digest match back
  into the attachment store, recovering it exactly; only images with no identical
  bytes anywhere are marked offloaded. So dropping the image files into the
  workspace — any subdirectory, any name — and reopening the session brings the
  pictures back.

## Configuration

The vault itself needs no configuration: the plugin inserts with an empty
`config`, and the vault directory name (`dsh-session-vault`) and the JSONL
format are fixed so vaults stay interchangeable across machines. Only auto-update
has three optional keys (see Auto-update): `autoUpdate`,
`updateCheckIntervalMs`, `updateInitialDelayMs`.

Each vault's `workspace.json` also carries a `kind: "dsh-vault"` marker, so the
plugin recognizes a vault by its content rather than relying on the directory
name alone.

## Development

```sh
# syntax check
node --check lib/index.js
node --check lib/vault.js
node --check lib/self-update.js
```

The plugin is ESM with no third-party dependencies (`lib/index.js` +
`lib/vault.js` + `lib/self-update.js`) and no build step; DSH host packages are
peer dependencies. It exports `apply`, `inject`, and `name`, and the bundle
layer `cordis.patch.yml` inserts it into the profile composition. The JSONL
format is self-contained and independent of the harness, so `lib/vault.js` can
be unit-tested directly.

## License

MIT
