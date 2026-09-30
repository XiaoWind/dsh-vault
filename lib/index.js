/**
 * dsh-vault — make every DSH conversation and log portable with the workspace.
 *
 * The plugin keeps a `dsh-session-vault/` directory inside each workspace folder:
 *
 *   - `sessions/<id>.jsonl` mirrors every session whose `cwd` is the workspace,
 *     written incrementally as events are appended and rewritten on dispose;
 *   - `workspace.json` caches the workspace title.
 *
 * Because the vault lives inside the workspace folder, copying that folder to
 * another computer carries every conversation with it. On that new machine the
 * plugin, when the folder is selected as a workspace, imports the missing
 * sessions back into DSH persistence (rebinding their `cwd` to the current
 * location) and restores the workspace title.
 *
 * @module dsh-vault
 */
import { access, realpath } from "node:fs/promises";
import { basename } from "node:path";
import {
  appendSessionEvents,
  ensureSessionHeader,
  listVaultSessions,
  readFirstLine,
  readRecordCoverage,
  readSessionFile,
  readWorkspaceMeta,
  sessionFileFor,
  writeSessionSnapshot,
  writeWorkspaceMeta,
} from "./vault.js";

/** Cordis function-plugin name, used in log labels. */
const name = "vault";

/** Services this plugin requires before it activates. */
const inject = ["sessionPersistence", "workspaceRegistry", "commands"];

/**
 * Maximum number of events handed to one persistence `append` batch. A vault
 * record can hold a whole conversation, and the backend validates and
 * deep-snapshots each batch in one traversal, so large logs are replayed in
 * contiguous slices instead of one multi-megabyte call.
 */
const APPEND_CHUNK = 500;

const USAGE = "Usage: /vault [status | restore | export | help]";

const HELP = [
  "Keeps a portable `dsh-session-vault/` inside each workspace folder: every",
  "conversation log and the workspace title are mirrored there, and restored",
  "when the folder is opened as a workspace (including on a new computer).",
  "",
  "Commands:",
  "  /vault status    show vaulted workspaces and session counts",
  "  /vault restore   import vaulted sessions/titles for known workspaces now",
  "  /vault export    (re)write vault files from current persistence now",
  "  /vault help      show this help",
].join("\n");

/** Resolve a directory to its canonical path, or `undefined` when absent. */
async function canonicalOf(path) {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** Whether a path exists on the filesystem. */
async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Release a persistence handle without masking the caller's own outcome: the
 * work being closed has already succeeded or failed on its own terms.
 */
async function closeQuietly(handle) {
  try {
    await handle?.close?.();
  } catch {
    // A handle that refuses to close cleanly must not fail the vault operation.
  }
}

/**
 * Cordis function plugin. Mirrors sessions into workspace vaults and restores
 * vaults into persistence when a workspace is opened.
 */
function apply(ctx, config = {}) {
  const persistence = ctx.sessionPersistence;
  const registry = ctx.workspaceRegistry;

  // `sessionPersistence` is addressed through per-session handles: the service
  // itself only lists/observes/creates/opens, while reads and appends belong
  // to the handle returned by `open`/`create`.
  const canList = typeof persistence?.list === "function";
  const canCreate = typeof persistence?.create === "function";
  const canOpen = typeof persistence?.open === "function";
  const canStat = typeof persistence?.stat === "function";
  const canRead = canStat && canOpen;

  /**
   * Session format version observed on a live session header, used to repair
   * vault records whose stored header carries a placeholder version. Plugins
   * cannot import the harness packages that own that constant (they are peers,
   * not installable dependencies of a plugin), but every live session header
   * states it.
   */
  let observedFormatVersion;

  function noteFormatVersion(header) {
    const version = header?.version;
    if (Number.isSafeInteger(version) && version > 0) observedFormatVersion = version;
  }

  /**
   * Stored session headers. `persistence.list()` yields observation snapshots
   * (`{ header, revision, sizeBytes }`); a bare header is also accepted so the
   * plugin keeps working against a runtime that returns records directly.
   */
  async function listStoredHeaders() {
    const snapshots = await persistence.list();
    const headers = [];
    for (const snapshot of snapshots ?? []) {
      const header = snapshot?.header ?? snapshot;
      if (header === null || typeof header !== "object" || typeof header.id !== "string") continue;
      noteFormatVersion(header);
      headers.push(header);
    }
    return headers;
  }

  /** Read one stored session as `{ meta, events }`, or `undefined`. */
  async function readStoredSession(id) {
    if (!canRead) return undefined;
    const snapshot = await persistence.stat(id);
    if (snapshot === null || snapshot === undefined) return undefined;
    noteFormatVersion(snapshot.header);
    const handle = await persistence.open(id, "read");
    try {
      const slice = await handle.read();
      return { meta: snapshot.header, events: slice?.events ?? [] };
    } finally {
      await closeQuietly(handle);
    }
  }

  /**
   * Seed the running format version from the vault itself, for the case where
   * persistence holds no session at all to learn it from (the first boot on a
   * machine that only received a copied workspace folder). Only the first line
   * of each record is read, and only until one states a usable version.
   */
  async function noteVaultFormatVersion(sessions) {
    if (observedFormatVersion !== undefined) return;
    for (const { file } of sessions) {
      try {
        const first = await readFirstLine(file);
        if (first === undefined) continue;
        noteFormatVersion(JSON.parse(first));
        if (observedFormatVersion !== undefined) return;
      } catch {
        // An unreadable header proves nothing; another record may still answer.
      }
    }
  }

  /** Create one stored session and replay its log in contiguous batches. */
  async function createStoredSession(header, events) {
    const handle = await persistence.create(header);
    try {
      if (events.length > 0) {
        if (typeof handle?.append !== "function") throw new Error("persistence create() returned a handle without append()");
        for (let at = 0; at < events.length; at += APPEND_CHUNK) {
          await handle.append(events.slice(at, at + APPEND_CHUNK));
        }
      }
      await handle.flush?.();
    } finally {
      await closeQuietly(handle);
    }
  }

  /**
   * Decide how a vault record's event log can be replayed.
   *
   * A durable session log is a contiguous run of `seq` values starting at 0,
   * so a record that starts later or skips a value cannot be replayed as-is:
   * `append` refuses a batch whose first seq is not the stored cursor, and
   * silently importing the prefix that happens to fit would fabricate a
   * truncated session that looks complete.
   *
   * @returns `{ events }` when replayable, `{ reason }` otherwise.
   */
  function planReplay(events) {
    if (events.length === 0) return { events };
    const first = events[0].seq;
    if (!Number.isSafeInteger(first) || first < 0) return { reason: "its first event carries no usable seq" };
    if (first !== 0) {
      return { reason: `its log starts at seq ${first}: ${first} event(s) at the head were never mirrored` };
    }
    for (const [index, event] of events.entries()) {
      if (event.seq !== index) {
        return { reason: `its log is not contiguous (expected seq ${index} at position ${index}, found ${String(event.seq)})` };
      }
    }
    return { events };
  }

  /**
   * Rebuild a storable header from a vault record, rebinding its location: the
   * vault may have been copied to a different absolute path on another
   * machine. A placeholder version (vaults written by older harnesses store 0)
   * falls back to the version the running harness uses.
   */
  function restorableHeader(meta, canonical) {
    const header = { ...meta, cwd: canonical };
    delete header.seedLength;
    if (typeof header.isSeeded !== "boolean") header.isSeeded = false;
    if (!Number.isSafeInteger(header.version) || header.version <= 0) {
      if (observedFormatVersion === undefined) delete header.version;
      else header.version = observedFormatVersion;
    }
    if (!Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0) header.delegationDepth = 0;
    return header;
  }

  /**
   * Whether an existing vault record already covers a live session's log.
   *
   * The mirror appends events as they publish, so a record silently loses any
   * event appended while the plugin was not loaded, and a session whose log is
   * rebuilt (resume, prune, migration) can leave an older generation behind in
   * front of a newer one. Comparing the record's first and last seq against the
   * live log detects both without reading either log in full.
   */
  async function recordMirrorsLog(file, session) {
    const events = session?.events ?? [];
    const coverage = await readRecordCoverage(file);
    if (coverage === undefined) return false;
    return coverage.firstSeq === events[0]?.seq && coverage.lastSeq === events.at(-1)?.seq;
  }

  // Per-session write serialization, so header creation and event appends
  // never interleave for the same session.
  const chains = new Map();
  function chainFor(sessionId, task) {
    const prior = chains.get(sessionId) ?? Promise.resolve();
    const next = prior.then(task, task);
    chains.set(sessionId, next.then(() => {}, () => {}));
    return next;
  }

  // ── mirror: write session logs + title into the workspace vault ──────────

  function sessionCwd(session) {
    const cwd = session?.header?.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
  }

  function mirrorHeader(session) {
    const cwd = sessionCwd(session);
    if (cwd === undefined) return;
    noteFormatVersion(session.header);
    chainFor(session.id, async () => {
      try {
        const file = sessionFileFor(cwd, session.id);
        // Entering a session is the one moment its whole log is in memory
        // without an event having just published, so a record that does not
        // cover that log (missed events, or a rebuilt log resumed on top of an
        // older generation) is repaired here rather than left silently short.
        if (!(await recordMirrorsLog(file, session))) {
          await writeSessionSnapshot(file, session.header, session.events ?? []);
        } else {
          await ensureSessionHeader(file, session.header);
        }
        await writeWorkspaceMeta(cwd, basename(cwd), { onlyIfMissing: true });
      } catch (error) {
        ctx.logger.warn(`dsh-vault: mirror header failed for "${session.id}": ${String(error)}`);
      }
    });
  }

  function mirrorEvents(session, events) {
    const cwd = sessionCwd(session);
    if (cwd === undefined || events.length === 0) return;
    noteFormatVersion(session.header);
    chainFor(session.id, async () => {
      try {
        const file = sessionFileFor(cwd, session.id);
        await ensureSessionHeader(file, session.header);
        await appendSessionEvents(file, events);
      } catch (error) {
        ctx.logger.warn(`dsh-vault: mirror append failed for "${session.id}": ${String(error)}`);
      }
    });
  }

  function mirrorSnapshot(session) {
    const cwd = sessionCwd(session);
    if (cwd === undefined) return;
    noteFormatVersion(session.header);
    chainFor(session.id, async () => {
      try {
        await writeSessionSnapshot(sessionFileFor(cwd, session.id), session.header, session.events);
        await writeWorkspaceMeta(cwd, basename(cwd), { onlyIfMissing: true });
      } catch (error) {
        ctx.logger.warn(`dsh-vault: mirror snapshot failed for "${session.id}": ${String(error)}`);
      }
    });
  }

  // ── restore: import vault sessions + title into persistence/registry ─────

  const restoredPaths = new Set();
  const inflight = new Map();

  async function restoreWorkspace(cwd, options = {}) {
    const canonical = await canonicalOf(cwd);
    if (canonical === undefined) return { imported: 0, title: undefined };
    // An explicit `/vault restore` re-scans a workspace the boot pass already
    // covered, so vault files copied in while the harness is running import
    // without a restart.
    if (options.force === true) restoredPaths.delete(canonical);
    if (restoredPaths.has(canonical)) return { imported: 0, title: undefined };
    const prior = inflight.get(canonical);
    if (prior !== undefined) return prior;

    const run = (async () => {
      let imported = 0;
      const vaultMeta = await readWorkspaceMeta(canonical);
      const title =
        vaultMeta !== undefined && typeof vaultMeta.title === "string" && vaultMeta.title.trim() !== ""
          ? vaultMeta.title.trim()
          : undefined;

      let present = new Set();
      try {
        present = new Set((await listStoredHeaders()).map((header) => header.id));
      } catch (error) {
        ctx.logger.warn(`dsh-vault: cannot list persisted sessions: ${String(error)}`);
      }

      const sessions = await listVaultSessions(canonical);

      if (canCreate) {
        await noteVaultFormatVersion(sessions);
        for (const { id, file } of sessions) {
          if (present.has(id)) continue;
          const snapshot = await readSessionFile(file);
          if (snapshot === undefined) {
            ctx.logger.warn(`dsh-vault: vault file for "${id}" has no readable header; skipping it`);
            continue;
          }
          if (snapshot.meta.id !== id) {
            ctx.logger.warn(
              `dsh-vault: vault file for "${id}" carries header id "${String(snapshot.meta.id)}"; skipping it`,
            );
            continue;
          }
          const plan = planReplay(snapshot.events);
          if (plan.reason !== undefined) {
            ctx.logger.warn(`dsh-vault: cannot restore session "${id}": ${plan.reason}`);
            continue;
          }
          try {
            await createStoredSession(restorableHeader(snapshot.meta, canonical), plan.events);
            present.add(id);
            imported += 1;
          } catch (error) {
            ctx.logger.warn(`dsh-vault: import failed for session "${id}": ${String(error)}`);
          }
        }
      }

      // Ensure the workspace exists with the vaulted title (create-or-reuse).
      let workspace;
      try {
        workspace = await registry.create(canonical, title ?? basename(canonical));
        if (title !== undefined && workspace.title !== title) await workspace.setTitle(title);
      } catch (error) {
        ctx.logger.warn(`dsh-vault: workspace restore failed for "${canonical}": ${String(error)}`);
      }

      // Attach the vault sessions that persistence now holds (idempotent).
      if (workspace !== undefined) {
        for (const { id } of sessions) {
          if (!present.has(id)) continue;
          try {
            await workspace.attachSession(id);
          } catch (error) {
            ctx.logger.warn(`dsh-vault: attach failed for session "${id}": ${String(error)}`);
          }
        }
      }

      if (imported > 0) {
        ctx.logger.info(`dsh-vault: imported ${imported} session(s) from "${canonical}"`);
      }
      return { imported, title };
    })();

    inflight.set(canonical, run);
    try {
      return await run;
    } finally {
      inflight.delete(canonical);
      restoredPaths.add(canonical);
    }
  }

  async function syncWorkspace(cwd, options = {}) {
    const canonical = await canonicalOf(cwd);
    if (canonical === undefined) return;
    try {
      const workspace = registry.list().find((candidate) => candidate.path === canonical);
      const title = workspace?.title ?? basename(canonical);
      await writeWorkspaceMeta(canonical, title);
      if (!canList || !canRead) return;
      const headers = await listStoredHeaders();
      for (const header of headers) {
        if (typeof header.cwd !== "string") continue;
        const headerCwd = await canonicalOf(header.cwd);
        if (headerCwd !== canonical) continue;
        const file = sessionFileFor(canonical, header.id);
        if (options.force !== true && (await fileExists(file))) continue;
        const snapshot = await readStoredSession(header.id);
        if (snapshot === undefined) continue;
        await writeSessionSnapshot(file, snapshot.meta, snapshot.events);
      }
    } catch (error) {
      ctx.logger.warn(`dsh-vault: export failed for "${cwd}": ${String(error)}`);
    }
  }

  async function restoreAll(options = {}) {
    const paths = registry.list().map((workspace) => workspace.path);
    const results = [];
    for (const path of paths) results.push(await restoreWorkspace(path, options));
    return results;
  }

  async function exportAll(options = {}) {
    const paths = registry.list().map((workspace) => workspace.path);
    for (const path of paths) await syncWorkspace(path, options);
    return paths.length;
  }

  function onDomainChanged(change) {
    if (change?.domain !== "workspace") return;
    if (change?.table !== "workspaces") return;
    if (change?.operation !== "put") return;
    const record = change.value;
    if (record === null || typeof record !== "object" || typeof record.path !== "string") return;
    const path = record.path;
    void (async () => {
      const canonical = await canonicalOf(path);
      if (canonical === undefined) return;
      if (!inflight.has(canonical) && !restoredPaths.has(canonical)) {
        await restoreWorkspace(canonical);
      }
      // Propagate the authoritative registry title to the vault (covers renames).
      const workspace = registry.list().find((candidate) => candidate.path === canonical);
      if (workspace !== undefined) {
        await writeWorkspaceMeta(canonical, workspace.title).catch(() => {});
      }
    })();
  }

  // ── /vault command ───────────────────────────────────────────────────────

  async function statusText() {
    const lines = [];
    const workspaces = registry.list();
    lines.push(`Vaulted workspaces: ${workspaces.length}`);
    for (const workspace of workspaces) {
      const sessions = await listVaultSessions(workspace.path);
      lines.push(`- ${workspace.title} (${workspace.path}) — ${sessions.length} session(s)`);
    }
    if (workspaces.length === 0) {
      lines.push("No workspaces are registered yet. Open a folder as a workspace to vault it.");
    }
    return { kind: "success", text: lines.join("\n") };
  }

  async function runCommand(invocation) {
    const input = (invocation.rawInput ?? "").trim().toLowerCase();
    if (input === "" || input === "status") return await statusText();
    if (input === "help") return { kind: "success", text: HELP };
    if (input === "restore") {
      const results = await restoreAll({ force: true });
      const total = results.reduce((sum, result) => sum + result.imported, 0);
      return {
        kind: "success",
        text: total > 0 ? `Restored ${total} session(s) from workspace vaults.` : "No new sessions to restore.",
      };
    }
    if (input === "export") {
      const count = await exportAll({ force: true });
      return { kind: "success", text: `Exported vault files for ${count} workspace(s).` };
    }
    return { kind: "error", text: USAGE };
  }

  ctx.effect(() => {
    const offEvent = ctx.on("session/event", (session, event) => mirrorEvents(session, [event]));
    const offCreated = ctx.on("session/created", (session) => mirrorHeader(session));
    const offDisposed = ctx.on("session/disposed", (session) => mirrorSnapshot(session));
    const offDomain = ctx.on("domain/changed", onDomainChanged);
    const disposeCommand = ctx.commands.register({
      name: "vault",
      description: "portable workspace vault: session logs + title saved into the workspace folder",
      input: { hint: "status | restore | export | help" },
      handler: (invocation) => runCommand(invocation),
    });

    // Boot: restore known workspaces first (apply vault titles), then export
    // current state back to the vault (backfill sessions created before the
    // plugin was installed).
    void (async () => {
      try {
        const initial = registry.list();
        for (const workspace of initial) await restoreWorkspace(workspace.path);
        for (const workspace of registry.list()) await syncWorkspace(workspace.path);
      } catch (error) {
        ctx.logger.warn(`dsh-vault: boot restore failed: ${String(error)}`);
      }
    })();

    return () => {
      offEvent();
      offCreated();
      offDisposed();
      offDomain();
      disposeCommand();
    };
  });
}

export { apply, inject, name };
