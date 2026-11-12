// Unit tests for ATO-1441 (main/studio-forget-key.ts, StudioMedia.forgetOpenRouterKey),
// against the built output.
// Run: npm run build && npm run test:unit
// Removing OpenRouter in the desktop also takes its key out of Atomic Core
// (Core keeps it in credentials.json for image and video), as the terminal
// does since ATO-425: only for an OpenRouter entry, only when no OpenRouter
// key is left, only when Core is installed, and never failing the removal.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { forgetOpenRouterMedia, removeProviderForgettingMedia } = require("../out/main/studio-forget-key.js");
const { StudioMedia } = require("../out/main/studio-media.js");

/** Deps that record what reached Core; `over` replaces any of them. */
function harness(over = {}) {
  const seen = { removed: [], forgets: 0, logs: [], background: [] };
  const deps = {
    remove: async (id) => { seen.removed.push(id); return { ok: true, stdout: "", stderr: "", removedKind: "openrouter" }; },
    installed: async () => true,
    keyLeft: async () => null,
    forget: async () => { seen.forgets += 1; },
    log: (line) => seen.logs.push(line),
    background: (work) => seen.background.push(work),
    ...over,
  };
  return { deps, seen, settled: () => Promise.all(seen.background) };
}

test("removing OpenRouter with Core installed and no key left sends the DELETE to Core", async () => {
  const { deps, seen, settled } = harness();
  const res = await removeProviderForgettingMedia("openrouter", deps);
  assert.equal(res.ok, true);
  assert.deepEqual(await settled(), [true]);
  assert.equal(seen.forgets, 1);
  assert.deepEqual(seen.removed, ["openrouter"]);
  // The kind is the IPC answer's business no longer: the window gets the removal's result only.
  assert.equal("removedKind" in res, false);
});

test("Core not installed: nothing is sent and nothing is downloaded", async () => {
  const { deps, seen, settled } = harness({ installed: async () => false });
  const res = await removeProviderForgettingMedia("openrouter", deps);
  assert.equal(res.ok, true);
  assert.deepEqual(await settled(), [false]);
  assert.equal(seen.forgets, 0);
});

test("removing another provider leaves Core alone", async () => {
  const { deps, seen } = harness({
    remove: async () => ({ ok: true, stdout: "", stderr: "", removedKind: "anthropic" }),
  });
  const res = await removeProviderForgettingMedia("anthropic", deps);
  assert.equal(res.ok, true);
  assert.equal(seen.background.length, 0);
  assert.equal(seen.forgets, 0);
});

test("another OpenRouter key still saved: Core keeps it", async () => {
  const { deps, seen, settled } = harness({ keyLeft: async () => "sk-or-dummy-still-here" });
  await removeProviderForgettingMedia("openrouter-2", deps);
  assert.deepEqual(await settled(), [false]);
  assert.equal(seen.forgets, 0);
  // The key left is never logged.
  assert.equal(seen.logs.join("\n").includes("sk-or-dummy"), false);
});

test("a removal that failed, or removed nothing, does not reach Core", async () => {
  for (const result of [
    { ok: false, stdout: "", stderr: "", error: "config changed" },
    { ok: true, stdout: "", stderr: "" },
  ]) {
    const { deps, seen } = harness({ remove: async () => result });
    const res = await removeProviderForgettingMedia("openrouter", deps);
    assert.equal(res.ok, result.ok);
    assert.equal(seen.background.length, 0);
  }
});

test("the removal still succeeds when the DELETE throws; the failure is only logged", async () => {
  const { deps, seen, settled } = harness({ forget: async () => { throw new Error("Atomic Core could not be reached."); } });
  const res = await removeProviderForgettingMedia("openrouter", deps);
  assert.equal(res.ok, true);
  assert.equal(res.error, undefined);
  assert.deepEqual(await settled(), [false]);
  assert.equal(seen.logs.length, 1);
  assert.match(seen.logs[0], /could not reach|could not remove/i);
});

test("the removal answers without waiting for Core", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { deps, settled } = harness({ forget: () => gate });
  const res = await removeProviderForgettingMedia("openrouter", deps);
  assert.equal(res.ok, true);
  release();
  assert.deepEqual(await settled(), [true]);
});

test("forgetOpenRouterMedia never throws, even when the install check does", async () => {
  const logs = [];
  const ok = await forgetOpenRouterMedia({
    installed: async () => { throw new Error("EACCES"); },
    keyLeft: async () => null,
    forget: async () => { throw new Error("must not be called"); },
    log: (line) => logs.push(line),
  });
  assert.equal(ok, false);
  assert.equal(logs.length, 1);
});

/* ---- StudioMedia.forgetOpenRouterKey against a stand-in Core ---- */

const VERSION = "0.18.6";
const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

async function fakeCore(dataDir) {
  const dataFolder = join(dataDir, "core", "versions", VERSION, "data");
  const seen = [];
  const server = createServer((req, res) => {
    const path = req.url.replace(/^\/atomic\/v1/, "");
    seen.push(`${req.method} ${path}`);
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close");
    if (path === "/snapshot") {
      return res.end(JSON.stringify({
        instance_id: "this-app", version: VERSION, protocol: 2, owner_scope: "cli", data_folder: dataFolder, sessions: [],
      }));
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  mkdirSync(join(dataFolder, "atomic-core"), { recursive: true });
  writeFileSync(join(dataFolder, "atomic-core", "control-token"), "token");
  writeFileSync(join(dataFolder, "atomic-core", "instance.lock"), JSON.stringify({
    state: "ready", instance_id: "this-app", control_host: "127.0.0.1", control_port: server.address().port,
  }));
  return { seen };
}

test("StudioMedia sends DELETE /cloud/providers/openrouter to the running Core and leaves it running", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "studio-forget-key-")));
  roots.push(root);
  const dataDir = join(root, "models");
  const core = await fakeCore(dataDir);
  const studio = new StudioMedia({
    dataDir: () => dataDir, stateDir: root, coreVersion: VERSION, openRouterKey: async () => null,
    emitJob: () => {}, emitLocal: () => {},
    coreRequest: () => { throw new Error("forgetting a key must not download Core"); },
  });
  await studio.forgetOpenRouterKey();
  assert.ok(core.seen.includes("DELETE /cloud/providers/openrouter"), core.seen.join(", "));
  // A Core that was already running is not this call's to retire.
  assert.equal(core.seen.includes("POST /shutdown"), false, core.seen.join(", "));
  studio.dispose();
});
