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
 * Cordis function plugin. Mirrors sessions into workspace vaults and restores
 * vaults into persistence when a workspace is opened.
 */
function apply(ctx, config = {}) {
  const persistence = ctx.sessionPersistence;
  const registry = ctx.workspaceRegistry;

  const canCreate = typeof persistence?.create === "function";
  const canAppend = typeof persistence?.append === "function";
  const canInspect = typeof persistence?.inspect === "function";

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
    chainFor(session.id, async () => {
      try {
        await ensureSessionHeader(sessionFileFor(cwd, session.id), session.header);
        await writeWorkspaceMeta(cwd, basename(cwd), { onlyIfMissing: true });
      } catch (error) {
        ctx.logger.warn(`dsh-vault: mirror header failed for "${session.id}": ${String(error)}`);
      }
    });
  }

  function mirrorEvents(session, events) {
    const cwd = sessionCwd(session);
    if (cwd === undefined || events.length === 0) return;
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

  async function restoreWorkspace(cwd) {
    const canonical = await canonicalOf(cwd);
    if (canonical === undefined) return { imported: 0, title: undefined };
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
        present = new Set((await persistence.list()).map((header) => header.id));
      } catch (error) {
        ctx.logger.warn(`dsh-vault: cannot list persisted sessions: ${String(error)}`);
      }

      const sessions = await listVaultSessions(canonical);

      if (canCreate && canAppend) {
        for (const { id, file } of sessions) {
          if (present.has(id)) continue;
          const snapshot = await readSessionFile(file);
          if (snapshot === undefined) continue;
          // Rebind to the current location: the vault may have been copied to
          // a different absolute path on another machine.
          snapshot.meta.cwd = canonical;
          try {
            await persistence.create(snapshot.meta);
            await persistence.append(id, snapshot.events);
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

      // Attach every vault session to the workspace (idempotent).
      if (workspace !== undefined) {
        for (const { id } of sessions) {
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

  async function syncWorkspace(cwd) {
    const canonical = await canonicalOf(cwd);
    if (canonical === undefined) return;
    try {
      const workspace = registry.list().find((candidate) => candidate.path === canonical);
      const title = workspace?.title ?? basename(canonical);
      await writeWorkspaceMeta(canonical, title);
      if (!canInspect) return;
      const headers = await persistence.list();
      for (const header of headers) {
        if (typeof header.cwd !== "string") continue;
        const headerCwd = await canonicalOf(header.cwd);
        if (headerCwd !== canonical) continue;
        const file = sessionFileFor(canonical, header.id);
        if (await fileExists(file)) continue;
        const snapshot = await persistence.inspect(header.id);
        await writeSessionSnapshot(file, snapshot.meta, snapshot.events);
      }
    } catch (error) {
      ctx.logger.warn(`dsh-vault: export failed for "${cwd}": ${String(error)}`);
    }
  }

  async function restoreAll() {
    const paths = registry.list().map((workspace) => workspace.path);
    const results = [];
    for (const path of paths) results.push(await restoreWorkspace(path));
    return results;
  }

  async function exportAll() {
    const paths = registry.list().map((workspace) => workspace.path);
    for (const path of paths) await syncWorkspace(path);
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
      const results = await restoreAll();
      const total = results.reduce((sum, result) => sum + result.imported, 0);
      return {
        kind: "success",
        text: total > 0 ? `Restored ${total} session(s) from workspace vaults.` : "No new sessions to restore.",
      };
    }
    if (input === "export") {
      const count = await exportAll();
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
