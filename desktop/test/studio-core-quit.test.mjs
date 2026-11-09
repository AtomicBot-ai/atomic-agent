// ATO-857: Atomic Core is not started just to read Studio's folders, and a
// Core with nothing to serve is shut down when the app quits.
// Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { StudioMedia } = require("../out/main/studio-media.js");
const { shutdownIdleStudioCore, studioCorePaths } = require("../out/main/studio-core-start.js");

const VERSION = "0.18.6";
const dirs = [];
const servers = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "studio-core-quit-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A stand-in Core on loopback that answers the control API and records the calls. */
async function fakeCore(dataDir, { sessions = [], embedding = false } = {}) {
  const paths = studioCorePaths(dataDir, VERSION);
  const calls = [];
  const clients = new Set();
  let nextClient = 1;
  const server = createServer((req, res) => {
    const path = req.url.replace("/atomic/v1", "");
    calls.push(`${req.method} ${path}`);
    const answer = (body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/snapshot") return answer({ instance_id: "fake", version: VERSION, protocol: 2, owner_scope: "cli", data_folder: paths.dataFolder, sessions });
    if (path === "/clients" && req.method === "POST") { const id = `c${nextClient++}`; clients.add(id); return answer({ client: { id }, heartbeat_interval_ms: 60_000 }); }
    if (path.startsWith("/clients/") && req.method === "DELETE") { clients.delete(path.slice("/clients/".length)); return answer({ ok: true }); }
    if (path === "/embedding/status") return answer({ enabled: embedding });
    if (path === "/diffusion/config" || path === "/diffusion/status") return answer({ outputDir: "/core/images", videoOutputDir: "/core/videos" });
    // A real Core refuses while another client still holds a lease.
    if (path === "/shutdown") return clients.size > 1 ? answer({ error: { code: "CLIENTS_ATTACHED", message: "in use" } }, 409) : answer({ ok: true });
    return answer({ ok: true });
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  mkdirSync(dirname(paths.lock), { recursive: true });
  writeFileSync(paths.lock, JSON.stringify({ state: "ready", control_host: "127.0.0.1", control_port: server.address().port, instance_id: "fake" }));
  writeFileSync(paths.token, "secret");
  return calls;
}

function media(dataDir, extra = {}) {
  return new StudioMedia({
    dataDir: () => dataDir,
    stateDir: join(dataDir, "state"),
    coreVersion: VERSION,
    emitJob: () => undefined,
    emitLocal: () => undefined,
    openRouterKey: async () => null,
    ...extra,
  });
}

test("reading the output folders starts no Core and downloads nothing", async () => {
  const dataDir = tempDir();
  mkdirSync(join(dataDir, "state"));
  let installs = 0;
  const studio = media(dataDir, { coreRequest: async () => { installs++; throw new Error("no network in this test"); } });
  const dir = await studio.outputDir("image");
  assert.equal(dir.path, join(dataDir, "studio", "images"));
  assert.equal(dir.isDefault, true);
  assert.equal(installs, 0, "the folder name must not install Core");
  assert.equal(existsSync(studioCorePaths(dataDir, VERSION).log), false, "the folder name must not start Core");
  studio.dispose();
});

test("reading the output folders does not touch a Core Studio has not set up", async () => {
  const dataDir = tempDir();
  mkdirSync(join(dataDir, "state"));
  const calls = await fakeCore(dataDir);
  const studio = media(dataDir);
  const dir = await studio.outputDir("video");
  assert.equal(dir.path, join(dataDir, "studio", "videos"));
  assert.deepEqual(calls, []);
  studio.dispose();
});

test("a Core serving nothing is shut down", async () => {
  const dataDir = tempDir();
  const calls = await fakeCore(dataDir);
  assert.equal(await shutdownIdleStudioCore(dataDir, VERSION), true);
  assert.ok(calls.includes("POST /shutdown"));
});

test("a Core with a model session stays up and our lease is returned", async () => {
  const dataDir = tempDir();
  const calls = await fakeCore(dataDir, { sessions: [{ id: "chat" }] });
  assert.equal(await shutdownIdleStudioCore(dataDir, VERSION), false);
  assert.ok(!calls.includes("POST /shutdown"));
  assert.ok(calls.includes("DELETE /clients/c1"));
});

test("a Core with the embedding module on stays up", async () => {
  const dataDir = tempDir();
  const calls = await fakeCore(dataDir, { embedding: true });
  assert.equal(await shutdownIdleStudioCore(dataDir, VERSION), false);
  assert.ok(!calls.includes("POST /shutdown"));
});

test("no running Core: nothing to shut down", async () => {
  assert.equal(await shutdownIdleStudioCore(tempDir(), VERSION), false);
});

test("a Core Studio set up reports its folders", async () => {
  const dataDir = tempDir();
  mkdirSync(join(dataDir, "state"));
  await fakeCore(dataDir);
  const studio = media(dataDir);
  await studio.ready();
  assert.equal((await studio.outputDir("image")).path, "/core/images");
  studio.dispose();
});

test("a quit gives back Studio's lease and shuts down a Core nothing needs", async () => {
  const dataDir = tempDir();
  mkdirSync(join(dataDir, "state"));
  const calls = await fakeCore(dataDir);
  const studio = media(dataDir);
  await studio.ready();
  await studio.withLease(async () => undefined);
  assert.equal(await studio.retireCoreOnQuit(), true);
  assert.ok(calls.includes("POST /shutdown"));
  studio.dispose();
});

test("a quit during a generation or an engine install leaves Core running", async () => {
  const dataDir = tempDir();
  mkdirSync(join(dataDir, "state"));
  const calls = await fakeCore(dataDir);
  const studio = media(dataDir);
  await studio.ready();
  await studio.withLease(async () => {
    assert.equal(await studio.retireCoreOnQuit(), false);
  });
  assert.ok(!calls.includes("POST /shutdown"));
  studio.dispose();
});

test("a quit from an app that never used Studio asks Core nothing", async () => {
  const dataDir = tempDir();
  mkdirSync(join(dataDir, "state"));
  const calls = await fakeCore(dataDir);
  const studio = media(dataDir);
  assert.equal(await studio.retireCoreOnQuit(), false);
  assert.deepEqual(calls, []);
  studio.dispose();
});
