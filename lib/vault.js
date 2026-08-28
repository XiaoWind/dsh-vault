/**
 * dsh-vault — portable on-disk format helpers.
 *
 * A workspace's vault lives in a directory inside the workspace folder:
 *
 *   <workspace>/
 *     dsh-session-vault/
 *       workspace.json          # { version, kind, title, updatedAt }
 *       sessions/
 *         <encodedId>.jsonl     # header line + one JSON event per line
 *
 * The JSONL body mirrors the DSH session log shape: a first line tagged
 * `type: "session"` carries the header, then every following line is one
 * `SessionEvent` serialized with `JSON.stringify`. Session ids are encoded to
 * a single safe path segment (same algorithm the JSONL persistence backend
 * uses) so arbitrary ids cannot traverse the filesystem.
 *
 * This module is dependency-free (only `node:*`) so the format can be read,
 * written, and unit-tested without the harness.
 *
 * @module dsh-vault/vault
 */
import { randomBytes } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Directory name holding the vault inside a workspace folder. */
export const VAULT_DIR = "dsh-session-vault";

/** Subdirectory holding one JSONL file per session. */
export const SESSIONS_DIR = "sessions";

/** Workspace metadata filename inside the vault directory. */
export const WORKSPACE_FILE = "workspace.json";

/** Current vault metadata schema version. */
export const VAULT_VERSION = 1;

/** Encode an arbitrary string as one safe filesystem path segment. */
export function encodeSegment(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("cannot encode an empty path segment");
  }
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/** Decode a segment produced by {@link encodeSegment}. */
export function decodeSegment(segment) {
  let out = "";
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch !== "~") {
      out += ch;
      continue;
    }
    const hex = segment.slice(i + 1, i + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Error(`invalid escape in segment "${segment}"`);
    out += String.fromCharCode(Number.parseInt(hex, 16));
    i += 4;
  }
  return out;
}

/** The vault directory path for a workspace. */
export function vaultDirFor(cwd) {
  return join(cwd, VAULT_DIR);
}

/** The sessions directory path for a workspace. */
export function sessionsDirFor(cwd) {
  return join(vaultDirFor(cwd), SESSIONS_DIR);
}

/** The workspace metadata file path for a workspace. */
export function workspaceFileFor(cwd) {
  return join(vaultDirFor(cwd), WORKSPACE_FILE);
}

/** The session log file path for one session inside a workspace. */
export function sessionFileFor(cwd, sessionId) {
  return join(sessionsDirFor(cwd), `${encodeSegment(sessionId)}.jsonl`);
}

/** Serialize one session header to its header-line object. */
export function headerToLine(header) {
  return {
    type: "session",
    version: header.version ?? 0,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    ...(header.parentSession !== undefined ? { parentSession: header.parentSession } : {}),
    ...(header.seedLength !== undefined ? { seedLength: header.seedLength } : {}),
    ...(header.origin !== undefined ? { origin: header.origin } : {}),
    delegationDepth: header.delegationDepth ?? 0,
    ...(header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {}),
  };
}

/** Parse a header-line object back into a session header record. */
export function headerFromLine(line) {
  return {
    version: line.version,
    id: line.id,
    createdAt: line.createdAt,
    ...(line.cwd !== undefined ? { cwd: line.cwd } : {}),
    ...(line.parentSession !== undefined ? { parentSession: line.parentSession } : {}),
    ...(line.seedLength !== undefined ? { seedLength: line.seedLength } : {}),
    ...(line.origin !== undefined ? { origin: line.origin } : {}),
    delegationDepth: line.delegationDepth ?? 0,
    ...(line.agentPreset !== undefined ? { agentPreset: line.agentPreset } : {}),
  };
}

/** Render a header plus events as one JSONL document (trailing newline). */
export function serializeSnapshot(header, events) {
  const lines = [JSON.stringify(headerToLine(header))];
  for (const event of events) lines.push(JSON.stringify(event));
  return `${lines.join("\n")}\n`;
}

/**
 * Parse a JSONL document back into `{ meta, events }`, tolerating a torn
 * trailing line (a crash mid-append). Returns `undefined` when the header
 * line is absent or malformed.
 */
export function parseSnapshot(text) {
  const lines = text.split("\n");
  // Find the first non-empty line as the header.
  let headerLine = null;
  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0) continue;
    headerLine = line;
    start = i + 1;
    break;
  }
  if (headerLine === null) return undefined;
  let headerObj;
  try {
    headerObj = JSON.parse(headerLine);
  } catch {
    return undefined;
  }
  if (typeof headerObj !== "object" || headerObj === null || headerObj.type !== "session") {
    return undefined;
  }
  const meta = headerFromLine(headerObj);
  const events = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Torn final line: stop reading, keep the committed prefix.
      break;
    }
    if (typeof event !== "object" || event === null || typeof event.seq !== "number") continue;
    events.push(event);
  }
  return { meta, events };
}

/** Write a full session snapshot atomically (tmp file + rename). */
export async function writeSessionSnapshot(file, header, events) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const content = serializeSnapshot(header, events);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Ensure a session log file exists with its header line. */
export async function ensureSessionHeader(file, header) {
  try {
    await access(file);
    return;
  } catch {
    // missing — create with the header line only
  }
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(headerToLine(header))}\n`, "utf8");
}

/** Append events to an existing session log file (header already present). */
export async function appendSessionEvents(file, events) {
  if (events.length === 0) return;
  const lines = events.map((event) => JSON.stringify(event));
  await appendFile(file, `${lines.join("\n")}\n`, "utf8");
}

/** Read and parse a full session log file. */
export async function readSessionFile(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  return parseSnapshot(text);
}

/** Read just the first newline-terminated line of a file, or `undefined`. */
export async function readFirstLine(file) {
  const handle = await open(file, "r");
  try {
    const chunks = [];
    const buf = Buffer.alloc(8192);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) return undefined;
      const slice = buf.subarray(0, bytesRead);
      const nl = slice.indexOf(10);
      if (nl !== -1) {
        chunks.push(slice.subarray(0, nl));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(slice));
    }
  } finally {
    await handle.close();
  }
}

/**
 * List the sessions stored in a workspace vault, oldest first. Each entry
 * carries the decoded id, the log file path, and the header `createdAt` when
 * readable (sessions without a readable header sort last, by filename).
 */
export async function listVaultSessions(cwd) {
  const dir = sessionsDirFor(cwd);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    let id;
    try {
      id = decodeSegment(name.slice(0, -".jsonl".length));
    } catch {
      continue;
    }
    const file = join(dir, name);
    let createdAt = Number.POSITIVE_INFINITY;
    try {
      const first = await readFirstLine(file);
      if (first !== undefined) {
        const parsed = JSON.parse(first);
        if (typeof parsed?.createdAt === "number") createdAt = parsed.createdAt;
      }
    } catch {
      // fall through with infinite createdAt (sorts last)
    }
    entries.push({ id, file, createdAt });
  }
  entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return entries;
}

/** Read the workspace metadata (`{ title }`) from a vault, or `undefined`. */
export async function readWorkspaceMeta(cwd) {
  try {
    const text = await readFile(workspaceFileFor(cwd), "utf8");
    const parsed = JSON.parse(text);
    if (typeof parsed?.title === "string") return parsed;
  } catch {
    // missing or malformed
  }
  return undefined;
}

/**
 * Write workspace metadata. With `onlyIfMissing` the file is left untouched
 * when it already exists; otherwise the title is overwritten.
 */
export async function writeWorkspaceMeta(cwd, title, options = {}) {
  const safe = typeof title === "string" ? title.trim() : "";
  if (options.onlyIfMissing) {
    try {
      await access(workspaceFileFor(cwd));
      return;
    } catch {
      // missing — proceed
    }
  }
  await mkdir(vaultDirFor(cwd), { recursive: true });
  const record = {
    version: VAULT_VERSION,
    kind: "dsh-vault",
    title: safe === "" ? basename(cwd) : safe,
    updatedAt: Date.now(),
  };
  const file = workspaceFileFor(cwd);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record)}\n`, "utf8");
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
