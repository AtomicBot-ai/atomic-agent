// ATO-1373: the vision projector landed for the model that is serving now.
// The projector is read only when a model starts, so the card offers
// Restart model; nothing restarts unasked (a restart would end a reply in
// progress). A model that is not running gets nothing: its next start reads
// the projector by itself.
//
// renderer.js is read as text; its decisions run in a vm context with what
// they call stood in for. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  const head = at >= 0 ? at : source.indexOf("\nasync function " + name + "(");
  assert.ok(head >= 0, name + " is a top-level function in renderer.js");
  return source.slice(head + 1, source.indexOf("\n}\n", head) + 2);
}

function ctx(extra) {
  const c = vm.createContext({
    VISION: { restart: null }, DL: { ready: null }, LLMP: { status: null, msg: null, statusErr: null },
    LIVE_CONFIG: null, backend: "local", busy: null, restartOk: true, restarts: 0, toasts: [], renders: 0,
    ...extra,
  });
  vm.runInContext(`
    function liveBackend() { return backend; }
    function render() { renders++; }
    function toast(title, text, tone) { toasts.push({ title, text, tone }); }
    function dlCardName(r) { return r.id; }
    async function llmTurnsRunning() { return busy; }
    function llmStopRefusal() { return 'Not while a turn is running'; }
    async function llmRestartModel() { restarts++; return restartOk; }
  `, c);
  for (const name of ["modelServingNow", "visionLanded", "visionRestart", "dlCardLine", "dlRowMoving"]) vm.runInContext(fn(name), c);
  return c;
}
const running = (id, pid = 41) => ({ daemonRunning: true, activeModel: id, daemonPid: pid });

test("a projector for the serving model offers a restart, not a Switch", () => {
  const c = ctx();
  c.LLMP.status = running("gemma-4-e4b");
  assert.equal(c.visionLanded("gemma-4-e4b"), true);
  assert.equal(c.VISION.restart.id, "gemma-4-e4b");
  assert.equal(c.VISION.restart.pid, 41);
  assert.equal(c.restarts, 0, "nothing restarts unasked");
});

test("a model that is not running gets no offer: its next start reads the projector", () => {
  const c = ctx();
  c.LLMP.status = running("qwen-3.5-4b");
  assert.equal(c.visionLanded("gemma-4-e4b"), false);
  c.LLMP.status = { daemonRunning: false, activeModel: "gemma-4-e4b" };
  assert.equal(c.visionLanded("gemma-4-e4b"), false);
  assert.equal(c.VISION.restart, null);
});

test("without a status reading, the live local pick stands in", () => {
  const c = ctx({ LIVE_CONFIG: { localModels: { managed: { modelId: "gemma-4-e4b" } } } });
  assert.equal(c.modelServingNow("gemma-4-e4b"), true);
  c.backend = "cloud";
  assert.equal(c.modelServingNow("gemma-4-e4b"), false);
});

test("Restart under a running reply is refused and says so; the offer stays", async () => {
  const c = ctx({ busy: { here: true } });
  c.LLMP.status = running("gemma-4-e4b");
  c.visionLanded("gemma-4-e4b");
  await c.visionRestart();
  assert.equal(c.restarts, 0, "the reply is not cut off");
  assert.match(c.VISION.restart.error, /turn is running/);
  assert.equal(c.dlCardLine({ state: "restart", error: c.VISION.restart.error }), c.VISION.restart.error);
});

test("Restart when idle restarts once and clears the offer", async () => {
  const c = ctx();
  c.LLMP.status = running("gemma-4-e4b");
  c.visionLanded("gemma-4-e4b");
  await c.visionRestart();
  assert.equal(c.restarts, 1);
  assert.equal(c.VISION.restart, null);
  assert.equal(c.toasts[0].title, "Model restarted");
});

test("a failed restart keeps the offer with the reason", async () => {
  const c = ctx({ restartOk: false });
  c.LLMP.status = running("gemma-4-e4b");
  c.visionLanded("gemma-4-e4b");
  c.LLMP.statusErr = "models start failed: boom";
  await c.visionRestart();
  assert.equal(c.VISION.restart.busy, false);
  assert.equal(c.VISION.restart.error, "models start failed: boom");
});

test("the offer row is not a download in progress", () => {
  const c = ctx();
  assert.equal(c.dlRowMoving({ src: "restart", state: "restart" }), false);
  assert.equal(c.dlRowMoving({ src: "restart", state: "restarting" }), false);
  assert.equal(c.dlRowMoving({ src: "dl", state: "active" }), true);
  assert.equal(c.dlCardLine({ state: "restart" }), "Restart the model to read images.");
});

test("the picker's pull reads the status afresh: a stale reading of the old model does not answer", async () => {
  const c = ctx({ LIVE_CONFIG: { localModels: { managed: { modelId: "gemma-4-e4b" } } } });
  // Settings was open earlier on the old model; the picker switched to Gemma since.
  c.LLMP.status = running("qwen-3.5-4b", 17);
  vm.runInContext(`
    var snapshots = 0;
    function bswSnapshot() { snapshots++; }
    function projectorSkippedText() { return 'text only'; }
    async function llmRefreshStatus() { LLMP.status = { daemonRunning: true, activeModel: 'gemma-4-e4b', daemonPid: 52 }; }
  `, c);
  vm.runInContext(fn("selPullFinished"), c);
  await c.selPullFinished("gemma-4-e4b", { ok: true });
  assert.equal(c.VISION.restart.id, "gemma-4-e4b");
  assert.equal(c.VISION.restart.pid, 52, "the new server's pid, not the old one");
  assert.equal(c.DL.ready, null, "no Switch for the current model");
});

test("both finished-pull paths ask visionLanded before a Switch", () => {
  assert.ok(source.includes("if (visionLanded(id)) { bswSnapshot(); render(); return; }"), "the composer's pull");
  assert.ok(source.indexOf("await llmRefreshStatus(true); } catch") < source.indexOf("if (visionLanded(id)) { bswSnapshot();"), "after a fresh status read");
  assert.ok(source.includes("if (!visionLanded(p.id)) DL.ready = {id:p.id};"), "Settings' pull");
  assert.ok(source.includes("if (v === 'visionRestart') { void visionRestart(); return; }"));
});
