// Unit tests for the quit's Studio Core retire (main/studio-core-retire.ts,
// StudioMedia.retireOnQuit), against the built output.
// Run: npm run build && npm run test:unit
// ATO-1351 / ATO-1352: a Core that Studio brought up is asked to exit at quit
// when it serves nothing, and only then: a model session, an enabled
// embedding module or a Core that is not this app's keeps it running.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { retireIdleStudioCore } = require("../out/main/studio-core-retire.js");
const { StudioMedia } = require("../out/main/studio-media.js");

const VERSION = "0.18.6";
const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function dataDirIn() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "studio-core-retire-")));
  roots.push(root);
  return { root, dataDir: join(root, "models") };
}

/** A stand-in Core on loopback with its lock and token in place; `state` shapes its answers. */
async function fakeCore(dataDir, state = {}) {
  const dataFolder = join(dataDir, "core", "versions", VERSION, "data");
  const seen = [];
  const server = createServer((req, res) => {
    const path = req.url.replace(/^\/atomic\/v1/, "");
    seen.push(`${req.method} ${path}`);
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close");
    if (path === "/snapshot") {
      return res.end(JSON.stringify({
        instance_id: "this-app", version: VERSION, protocol: 2, owner_scope: state.scope ?? "cli",
        data_folder: dataFolder, sessions: state.sessions ?? [],
      }));
    }
    if (path === "/clients" && req.method === "POST") return res.end(JSON.stringify({ client: { id: "quit-1" }, heartbeat_interval_ms: 5000 }));
    if (path === "/embedding/status") return res.end(JSON.stringify({ enabled: state.embedding === true }));
    if (path === "/shutdown") return res.end(JSON.stringify({ ok: true }));
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  mkdirSync(join(dataFolder, "atomic-core"), { recursive: true });
  writeFileSync(join(dataFolder, "atomic-core", "control-token"), "token");
  writeFileSync(join(dataFolder, "atomic-core", "instance.lock"), JSON.stringify({
    state: "ready", instance_id: "this-app", control_host: "127.0.0.1", control_port: server.address().port,
  }));
  const shutdowns = () => seen.filter((s) => s === "POST /shutdown").length;
  return { seen, shutdowns };
}

test("an idle Core is asked to exit, under a lease of its own", async () => {
  const { dataDir } = dataDirIn();
  const core = await fakeCore(dataDir);
  assert.equal(await retireIdleStudioCore(dataDir, VERSION), true);
  assert.equal(core.shutdowns(), 1, core.seen.join(", "));
  assert.ok(core.seen.indexOf("POST /clients") < core.seen.indexOf("POST /shutdown"), core.seen.join(", "));
  // The engine operation lock is let go afterwards.
  assert.equal(existsSync(join(dataDir, "core", "operation.lock")), false);
});

test("a Core with a model session stays, and its lease is let go", async () => {
  const { dataDir } = dataDirIn();
  const core = await fakeCore(dataDir, { sessions: [{ role: "chat" }] });
  assert.equal(await retireIdleStudioCore(dataDir, VERSION), false);
  assert.equal(core.shutdowns(), 0);
  assert.ok(core.seen.includes("DELETE /clients/quit-1"), core.seen.join(", "));
});

test("a Core with the embedding module on stays", async () => {
  const { dataDir } = dataDirIn();
  const core = await fakeCore(dataDir, { embedding: true });
  assert.equal(await retireIdleStudioCore(dataDir, VERSION), false);
  assert.equal(core.shutdowns(), 0);
});

test("a Core owned by something else is left alone", async () => {
  const { dataDir } = dataDirIn();
  const core = await fakeCore(dataDir, { scope: "app" });
  assert.equal(await retireIdleStudioCore(dataDir, VERSION), false);
  assert.equal(core.shutdowns(), 0);
});

test("no Core running: nothing to do, no throw", async () => {
  const { dataDir } = dataDirIn();
  assert.equal(await retireIdleStudioCore(dataDir, VERSION), false);
});

test("the engine lock held by a live process: the quit does not wait it out and leaves Core", async () => {
  const { dataDir } = dataDirIn();
  const core = await fakeCore(dataDir);
  writeFileSync(join(dataDir, "core", "operation.lock"), String(process.pid));
  const t0 = Date.now();
  assert.equal(await retireIdleStudioCore(dataDir, VERSION), false);
  assert.ok(Date.now() - t0 < 5_000);
  assert.equal(core.shutdowns(), 0);
  rmSync(join(dataDir, "core", "operation.lock"), { force: true });
});

test("a Studio that never reached Core leaves a running Core alone", async () => {
  const { root, dataDir } = dataDirIn();
  const core = await fakeCore(dataDir);
  const studio = new StudioMedia({
    dataDir: () => dataDir, stateDir: root, coreVersion: VERSION, openRouterKey: async () => null,
    emitJob: () => {}, emitLocal: () => {},
    coreRequest: () => { throw new Error("the quit must not download Core"); },
  });
  assert.equal(await studio.retireOnQuit(), false);
  assert.equal(core.seen.length, 0, core.seen.join(", "));
  studio.dispose();
});
