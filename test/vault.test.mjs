import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeSegment,
  encodeSegment,
  headerFromLine,
  headerToLine,
  listVaultSessions,
  parseSnapshot,
  readSessionFile,
  readWorkspaceMeta,
  serializeSnapshot,
  sessionFileFor,
  writeSessionSnapshot,
  writeWorkspaceMeta,
} from "../lib/vault.js";

test("encodeSegment/decodeSegment round-trip", () => {
  const ids = [
    "session-abc123",
    "..",
    ".",
    "../etc/passwd",
    "a/b\\c",
    "weird~tilde",
    "中文会话",
    "emoji-😀",
    "with:colon",
  ];
  for (const id of ids) {
    assert.equal(decodeSegment(encodeSegment(id)), id);
  }
});

test("encodeSegment neutralizes traversal and separators", () => {
  const encoded = encodeSegment("../etc/passwd");
  // A single safe path segment: no separators can remain.
  assert.ok(!encoded.includes("/"));
  assert.ok(!encoded.includes("\\"));
  // The bare traversal segments are special-cased so a lone "." or ".."
  // never becomes a real directory component.
  assert.notEqual(encodeSegment(".."), "..");
  assert.notEqual(encodeSegment("."), ".");
  assert.equal(decodeSegment(encodeSegment("../etc/passwd")), "../etc/passwd");
});

test("headerToLine/headerFromLine round-trip", () => {
  const header = {
    version: 0,
    id: "session-1",
    createdAt: 1700000000000,
    cwd: "C:\\work",
    parentSession: "session-0",
    seedLength: 12,
    origin: "subagent",
    delegationDepth: 2,
    agentPreset: "code",
  };
  assert.deepEqual(headerFromLine(headerToLine(header)), header);
});

test("headerToLine fills delegationDepth default", () => {
  const line = headerToLine({ id: "s", createdAt: 1 });
  assert.equal(line.type, "session");
  assert.equal(line.delegationDepth, 0);
  assert.equal(line.cwd, undefined);
});

test("serializeSnapshot/parseSnapshot round-trip", () => {
  const header = { version: 0, id: "session-1", createdAt: 1700000000000, cwd: "C:\\work", delegationDepth: 0 };
  const events = [
    { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } },
    { type: "user/message", seq: 1, time: 1001, data: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }, surfaceOp: "append" },
    { type: "turn/end", seq: 2, time: 1002, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const text = serializeSnapshot(header, events);
  const parsed = parseSnapshot(text);
  assert.deepEqual(parsed.meta, header);
  assert.deepEqual(parsed.events, events);
});

test("parseSnapshot tolerates a torn trailing line", () => {
  const header = { version: 0, id: "s", createdAt: 1, delegationDepth: 0 };
  const events = [{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }];
  const text = `${serializeSnapshot(header, events)}{"type": "assistant/chunk", "seq": 1, "time": 2, "data": `;
  const parsed = parseSnapshot(text);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].seq, 0);
});

test("writeSessionSnapshot/readSessionFile round-trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-vault-test-"));
  try {
    const header = { version: 0, id: "session-1", createdAt: 1700000000000, cwd: dir, delegationDepth: 0 };
    const events = [{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }];
    const file = sessionFileFor(dir, header.id);
    await writeSessionSnapshot(file, header, events);
    const read = await readSessionFile(file);
    assert.deepEqual(read.meta, header);
    assert.deepEqual(read.events, events);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeWorkspaceMeta/readWorkspaceMeta round-trip and onlyIfMissing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-vault-test-"));
  try {
    await writeWorkspaceMeta(dir, "My Project");
    assert.equal((await readWorkspaceMeta(dir)).title, "My Project");

    await writeWorkspaceMeta(dir, "Overwritten", { onlyIfMissing: true });
    assert.equal((await readWorkspaceMeta(dir)).title, "My Project");

    await writeWorkspaceMeta(dir, "Renamed");
    assert.equal((await readWorkspaceMeta(dir)).title, "Renamed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listVaultSessions decodes ids and sorts oldest first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-vault-test-"));
  try {
    const older = { version: 0, id: "older", createdAt: 1000, cwd: dir, delegationDepth: 0 };
    const newer = { version: 0, id: "newer", createdAt: 2000, cwd: dir, delegationDepth: 0 };
    await writeSessionSnapshot(sessionFileFor(dir, older.id), older, []);
    await writeSessionSnapshot(sessionFileFor(dir, newer.id), newer, []);
    const sessions = await listVaultSessions(dir);
    assert.deepEqual(sessions.map((s) => s.id), ["older", "newer"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
