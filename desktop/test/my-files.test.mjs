// ATO-1624: the "My files" bridge (main/my-files.ts). The agent's answers
// read into what the Settings screen shows, and a remote agent refused for
// adding, removing and picking folders. Against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const F = require("../out/main/my-files.js");
const O = require("../out/main/my-files-ocr.js");

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  fn.calls = calls;
  return fn;
}

const env = (fetchImpl, isRemote = false) => ({
  isRemote: () => isRemote,
  target: () => ({ base: "http://127.0.0.1:4100", headers: { authorization: "Bearer t" } }),
  fetchImpl,
});

test("the paths are the contract's", () => {
  assert.equal(F.MY_FILES_PATHS.folders, "/api/files/folders");
  assert.equal(F.MY_FILES_PATHS.status, "/api/files/status");
});

test("a folder list is read, rows without a path dropped, a missing name taken from the path", async () => {
  const f = fakeFetch(200, {
    folders: [
      { path: "/Users/me/Docs", name: "Docs", fileCount: 480, indexedCount: 120, addedAt: "2026-11-18T10:00:00Z" },
      { path: "/Users/me/Audio/", fileCount: 3, indexedCount: 3 },
      { name: "no path" },
      "junk",
    ],
  });
  const r = await F.listFolders(env(f));
  assert.equal(r.ok, true);
  assert.equal(r.folders.length, 2);
  assert.deepEqual(r.folders[0], { path: "/Users/me/Docs", name: "Docs", fileCount: 480, indexedCount: 120, addedAt: "2026-11-18T10:00:00Z" });
  assert.equal(r.folders[1].name, "Audio");
  assert.equal(f.calls[0].url, "http://127.0.0.1:4100/api/files/folders");
  assert.equal(f.calls[0].init.method, "GET");
});

test("a reply without `folders` is not mistaken for an empty list", () => {
  const r = F.interpretList(200, JSON.stringify({ items: [] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "error");
});

test("status is read and `done` follows the contract's rule", () => {
  const running = F.interpretStatus(200, JSON.stringify({ running: true, found: 480, indexed: 120, failed: 0, skipped: 0, current: "/a/b.pdf", updatedAt: "x" }));
  assert.equal(running.ok, true);
  assert.equal(running.status.done, false);
  assert.equal(running.status.current, "/a/b.pdf");
  const done = F.interpretStatus(200, JSON.stringify({ running: false, found: 10, indexed: 7, failed: 2, skipped: 1, updatedAt: "x",
    lastError: { path: "/a/c.pdf", message: "encrypted", at: "y" } }));
  assert.equal(done.status.done, true);
  assert.deepEqual(done.status.lastError, { path: "/a/c.pdf", message: "encrypted", at: "y" });
  const stillGoing = F.interpretStatus(200, JSON.stringify({ running: false, found: 10, indexed: 5, failed: 0, skipped: 0, updatedAt: "x" }));
  assert.equal(stillGoing.status.done, false);
  assert.equal(F.interpretStatus(200, JSON.stringify({ found: 1 })).ok, false, "no `running` is not a status");
  assert.equal(F.parseStatus({ running: true, found: -3, indexed: "7", failed: 0, skipped: 0 }).found, 0);
});

test("501 and the router's 404 mean the agent needs updating", () => {
  for (const [status, body] of [
    [501, { error: { message: "file index is not available", type: "not_implemented" } }],
    [404, { error: { message: "No route for GET /api/files/folders" } }],
    [404, ""],
  ]) {
    const r = F.interpretList(status, typeof body === "string" ? body : JSON.stringify(body));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unsupported", `${status}`);
    assert.match(r.error, /newer agent/);
  }
});

test("a 400 code becomes words a person can act on; an unknown code keeps the agent's message", () => {
  const known = F.interpretAdd(400, JSON.stringify({ error: { code: "inside_added", message: "parent /Users/me is indexed" } }));
  assert.equal(known.reason, "rejected");
  assert.equal(known.code, "inside_added");
  assert.match(known.error, /inside a folder/);
  const tooBroad = F.interpretAdd(400, JSON.stringify({ error: { code: "too_broad", message: "x" } }));
  assert.match(tooBroad.error, /too big/);
  const unknown = F.interpretAdd(400, JSON.stringify({ error: { code: "weird", message: "the agent says no" } }));
  assert.equal(unknown.error, "the agent says no");
});

test("add posts the path and reads the folder back", async () => {
  const f = fakeFetch(200, { folder: { path: "/Users/me/Docs", name: "Docs", fileCount: 0, indexedCount: 0, addedAt: "z" } });
  const r = await F.addFolder(env(f), "  /Users/me/Docs ");
  assert.equal(r.ok, true);
  assert.equal(r.folder.name, "Docs");
  assert.equal(f.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { path: "/Users/me/Docs" });
});

test("remove sends DELETE with the path and reads `removed`", async () => {
  const f = fakeFetch(200, { removed: true });
  const r = await F.removeFolder(env(f), "C:\\Users\\me\\Docs");
  assert.deepEqual(r, { ok: true, removed: true });
  assert.equal(f.calls[0].init.method, "DELETE");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { path: "C:\\Users\\me\\Docs" });
});

test("a relative or empty path never reaches the agent", async () => {
  const f = fakeFetch(200, {});
  for (const bad of ["", "Docs", "./Docs", null, 7, "/a\0b"]) {
    const r = await F.addFolder(env(f), bad);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid");
  }
  assert.equal(f.calls.length, 0);
});

test("a remote agent: no folder picking, adding or removing from this computer", async () => {
  const f = fakeFetch(200, { folder: { path: "/x" }, removed: true });
  const add = await F.addFolder(env(f, true), "/Users/me/Docs");
  const rm = await F.removeFolder(env(f, true), "/Users/me/Docs");
  assert.equal(add.reason, "remote");
  assert.equal(rm.reason, "remote");
  assert.match(add.error, /another computer/);
  assert.equal(f.calls.length, 0, "nothing is sent to the remote agent");
  assert.equal(F.pickRefusal(true).reason, "remote");
  assert.equal(F.pickRefusal(false), null);
});

test("a remote agent still lists its own folders and progress", async () => {
  const f = fakeFetch(200, { folders: [] });
  const r = await F.listFolders(env(f, true));
  assert.deepEqual(r, { ok: true, folders: [] });
});

test("no running agent and a network failure are results, not throws", async () => {
  const stopped = await F.indexStatus({ isRemote: () => false, target: () => { throw new Error("agent is not running"); } });
  assert.equal(stopped.reason, "not_running");
  const broken = await F.indexStatus(env(async () => { throw new Error("ECONNREFUSED"); }));
  assert.equal(broken.reason, "error");
  assert.match(broken.error, /ECONNREFUSED/);
});

test("capabilities: `fileIndex: true` turns the screen on, anything else keeps it off", () => {
  assert.equal(F.hasFileIndex({ fileIndex: true }), true);
  assert.equal(F.hasFileIndex({ agent: { fileIndex: true } }), true);
  assert.equal(F.hasFileIndex({ features: { fileIndex: true } }), true);
  assert.equal(F.hasFileIndex({ fileIndex: "yes" }), false);
  assert.equal(F.hasFileIndex({ agent: {} }), false);
  assert.equal(F.hasFileIndex(null), false);
});

test("preload exposes the six calls on the routes main handles", () => {
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  const ipc = readFileSync(new URL("../main/my-files-ipc.ts", import.meta.url), "utf8");
  for (const [name, channel] of [
    ["filesPickFolder", "files:pickFolder"],
    ["filesAddFolder", "files:addFolder"],
    ["filesRemoveFolder", "files:removeFolder"],
    ["filesListFolders", "files:listFolders"],
    ["filesStatus", "files:status"],
    ["filesRetry", "files:retry"],
  ]) {
    assert.match(preload, new RegExp(`${name}: .*"${channel}"`), name);
    assert.ok(ipc.includes(`ipcMain.handle("${channel}"`), channel);
  }
  assert.doesNotMatch(ipc, /readFile|readdir|statSync/, "main reads no files itself");
});

// ATO-2501: scans, photos and audio.
test("status carries the scanned pages read and the skip reasons, and an older agent reads as none", () => {
  const r = F.interpretStatus(200, JSON.stringify({ running: false, found: 3, indexed: 1, failed: 0, skipped: 2, updatedAt: "x",
    ocrPages: 12, skippedReasons: [{ reason: "disabled", count: 1 }, { reason: "", count: 4 }, { reason: "no text in the file", count: 0 }, "junk",
      { reason: "scan: OCR not available (no vision model is configured)", count: 1 }] }));
  assert.equal(r.status.ocrPages, 12);
  assert.deepEqual(r.status.skippedReasons, [
    { reason: "disabled", count: 1 },
    { reason: "scan: OCR not available (no vision model is configured)", count: 1 },
  ]);
  const old = F.parseStatus({ running: false, found: 1, indexed: 1, failed: 0, skipped: 0 });
  assert.equal(old.ocrPages, 0);
  assert.deepEqual(old.skippedReasons, []);
  const many = Array.from({ length: 12 }, (_, i) => ({ reason: `r${i}`, count: 1 }));
  assert.equal(F.parseSkippedReasons(many).length, 8);
});

test("retry posts to /api/files/retry and reads `requeued`", async () => {
  const f = fakeFetch(200, { requeued: 3 });
  const r = await O.retrySkipped(env(f));
  assert.deepEqual(r, { ok: true, requeued: 3 });
  assert.equal(f.calls[0].init.method, "POST");
  assert.match(f.calls[0].url, /\/api\/files\/retry$/);
  assert.equal((await O.retrySkipped(env(fakeFetch(200, { requeued: "3" })))).ok, false, "not a number is a bad reply");
  const old = await O.retrySkipped(env(fakeFetch(404, { error: { message: "No route for POST /api/files/retry" } })));
  assert.equal(old.reason, "unsupported");
});

test("retry is refused on a remote agent and sends nothing", async () => {
  const f = fakeFetch(200, { requeued: 1 });
  const r = await O.retrySkipped(env(f, true));
  assert.equal(r.reason, "remote");
  assert.equal(f.calls.length, 0);
});
