// The spotlight card: which catalogue row a launch offers, and the switch
// after its download. renderer.js is read as text; its decisions run in a vm
// context with what they call stood in for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { modelSpotlightPick, modelSpotlightParseDismissed } = require("../renderer/model-spotlight.js");

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function fn(name) {
  const plain = source.indexOf("\nfunction " + name + "(");
  const at = plain >= 0 ? plain : source.indexOf("\nasync function " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

// The real "Fits well" verdict.
const fits = vm.createContext({ TIGHT_FIT_CAUTION: "" });
for (const name of ["sizeStringGb", "ramEstimateFromSize", "fitFor"]) vm.runInContext(fn(name), fits);
const fitFor = fits.fitFor;

const row = (id, wants, extra) => ({ id, spotlight: true, minRamGb: wants - 4, recommendedRamGb: wants, downloaded: false, size: "9 GB", ...extra });
const pick = (models, over) => {
  const p = modelSpotlightPick({ models, ramGb: 32, dismissed: [], fitFor, ...over });
  return p ? p.id : null;
};

test("no marked row: nothing, whatever fits", () => {
  assert.equal(pick([{ id: "a", minRamGb: 4, recommendedRamGb: 8, downloaded: false }]), null);
  assert.equal(pick([]), null);
  assert.equal(modelSpotlightPick(undefined), null);
});

test("the largest that runs comfortably, first in list order on a tie", () => {
  assert.equal(pick([row("s", 8), row("m", 16), row("l", 28), row("xl", 64)]), "l");
  assert.equal(pick([row("first", 16), row("second", 16), row("small", 8)]), "first");
});

test("at exactly the recommended memory it fits; a tight fit is not offered", () => {
  assert.equal(pick([row("exact", 32)]), "exact");
  assert.equal(pick([row("tight", 36)]), null);
  assert.equal(pick([row("a", 8)], { ramGb: 0 }), null);
});

test("uncensored rows are never offered", () => {
  assert.equal(pick([row("u", 28, { uncensored: true }), row("s", 8)]), "s");
  assert.equal(pick([row("u", 28, { uncensored: true })]), null);
});

test("any marked row on disk retires the launch, even one that would not be offered", () => {
  assert.equal(pick([row("m", 16), row("s", 8, { downloaded: true })]), null);
  assert.equal(pick([row("m", 16), row("xl", 64, { downloaded: true })]), null);
  assert.equal(pick([row("m", 16), row("u", 16, { uncensored: true, downloaded: true })]), null);
});

test("a dismissed row is skipped for the next one that fits", () => {
  assert.equal(pick([row("m", 16), row("l", 28)], { dismissed: ["l"] }), "m");
  assert.equal(pick([row("l", 28)], { dismissed: ["l"] }), null);
});

test("a row with no memory figures is not offered on fitFor's estimate", () => {
  assert.equal(pick([{ id: "bare", spotlight: true, size: "2 GB", downloaded: false }]), null);
});

test("no room on the disk: nothing, and only the chosen row is measured", () => {
  const asked = [];
  const diskFit = (m) => { asked.push(m.id); return { ok: false }; };
  assert.equal(pick([row("m", 16), row("l", 28)], { diskFit }), null);
  assert.deepEqual(asked, ["l"]);
  assert.equal(pick([row("l", 28)], { diskFit: () => ({ ok: true }) }), "l");
});

test("a stranded row is offered again, alone; any other row on disk still retires the launch", () => {
  const stranded = row("m", 16, { downloaded: true });
  assert.equal(pick([stranded, row("l", 28)], { unfinished: "m" }), "m");
  assert.equal(pick([stranded, row("l", 28)]), null);
  assert.equal(pick([stranded, row("l", 28, { downloaded: true })], { unfinished: "m" }), null);
  assert.equal(pick([stranded], { unfinished: "m", dismissed: ["m"] }), null);
  assert.equal(pick([row("l", 28)], { unfinished: "m" }), "l");
});

test("the stored dismissals read safely", () => {
  assert.deepEqual(modelSpotlightParseDismissed('["a","b"]'), ["a", "b"]);
  assert.deepEqual(modelSpotlightParseDismissed('["a",3,""]'), ["a"]);
  for (const raw of [null, "", "not json", '{"a":1}']) assert.deepEqual(modelSpotlightParseDismissed(raw), []);
});

test("index.html loads model-spotlight.js before renderer.js", () => {
  const index = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const helper = index.indexOf('<script src="model-spotlight.js">');
  assert.ok(helper >= 0 && helper < index.indexOf('<script src="renderer.js">'));
});

test("the feature ships dormant: no catalogue row is marked", () => {
  const catalog = readFileSync(new URL("../main/model-catalog.ts", import.meta.url), "utf8");
  assert.doesNotMatch(catalog, /^\s*spotlight:\s*true/m);
});

test("the flag crosses to the window with the other catalogue fields", () => {
  const cli = readFileSync(new URL("../main/agent-cli.ts", import.meta.url), "utf8");
  assert.match(cli, /\.\.\.\(meta\.spotlight \? \{ spotlight: true \} : \{\}\)/);
});

/* ---- the card's click, in the renderer's own code ---- */

const REAL = [
  "dlBusy", "dlChipBusy", "xpullOwner", "dlRuntimePending", "dlResetPhases", "dlStart", "dlNext", "dlSpawn", "dlPullStart",
  "dlOnPull", "dlFail", "dlFailClear", "dlRequeue", "dlRetry", "dlCancel", "dlRuntimeMissed", "dlProjectorNext",
  "obStartLocalPull", "obPullFinished", "obModelLanded", "obActivateLocal", "obFlushDeferredActivate",
  "modelSpotlightNow", "modelSpotlightStart", "modelSpotlightStands", "modelSpotlightDismissed",
  "modelSpotlightUnfinished", "modelSpotlightMark", "modelSpotlightSettled",
];

const tick = () => new Promise((resolve) => setImmediate(resolve));

function app(models) {
  const store = new Map();
  const pulls = [];
  const switched = [];
  const phase = () => ({ state: "waiting", percent: 0, transferredBytes: 0, totalBytes: 0, drove: false });
  const c = vm.createContext({
    DL: {
      spotlight: null, ready: null, deferred: null, deferTimer: 0, error: null, dry: false, job: null, preparing: null, projector: null,
      queue: [], projectorQueue: [], startGone: [], failed: [], failSeq: 0, runSeq: 0, landed: null, activateAfter: null, switchAfter: null,
      rate: null, last: null, samples: 0, weights: phase(), runtime: phase(), runtimeError: null,
    },
    SPOT: { gate: true, ids: ["new"], asked: true, dismissed: null },
    OB: { open: false, settling: false, managedWrite: null },
    S: { room: "chat", settings: null },
    SEL: { local: models, pulling: null },
    LLMP: { pulling: null },
    ENGF: { fresh: false },
    SWX: { pending: 0 },
    STARTER: { phase: null },
    LIVE_CONFIG: {},
    SWXBR: { selectLocalModel() {} },
    BR: {
      modelSpotlightIds: async () => ["new"],
      modelsPull: async (id, opts) => { pulls.push({ id, opts: JSON.parse(JSON.stringify(opts)) }); return { ok: true }; },
      cancelPull() {},
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, v); },
      removeItem: (k) => { store.delete(k); },
    },
    swxRun: async (line, want) => { switched.push(want.model); return { ok: true }; },
    modelSpotlightPick,
    modelSpotlightParseDismissed,
    fitFor,
    route: "cloud:a:b",
    turn: false,
    onAnother: true,
  });
  vm.runInContext(`
    function render() {}
    function renderDlcard() {}
    function toast() {}
    function bswSnapshot() {}
    function bswReport() {}
    function obDispatch() {}
    function obLocalStartOf() { return null; }
    function obSetupPullFailed() {}
    function obSetupPullForgetFor() {}
    function obSetupPullLanded() {}
    function obSetupPullMmproj() { return null; }
    function obModelLandedRead() {}
    function obFetchProjector() {}
    function dlAdopt() { return false; }
    function modelDiskFit() { return { ok: true }; }
    function hostRamGb() { return 32; }
    function obBackendMissing() { return false; }
    async function obBackendStatusText() { return ""; }
    function dlRouteKey() { return route; }
    function restartStopsTurn() { return turn; }
    function obRunsOnAnotherModel() { return onAnother; }
  `, c);
  for (const name of REAL) vm.runInContext(fn(name), c);
  const finish = async (ev) => { c.dlOnPull({ id: "new", done: true, ok: true, ...ev }); await tick(); };
  const click = async () => { await c.modelSpotlightStart(); await tick(); };
  return { c, pulls, switched, store, finish, click };
}
const vision = (extra) => row("new", 16, { vision: true, ...extra });

test("Download and switch asks main for the projector with a vision model, and not with a text one", async () => {
  const a = app([vision()]);
  await a.click();
  assert.deepEqual(a.pulls, [{ id: "new", opts: { trigger: "spotlight", mmproj: true } }]);
  const b = app([row("new", 16, { vision: false })]);
  await b.click();
  assert.deepEqual(b.pulls, [{ id: "new", opts: { trigger: "spotlight" } }]);
});

test("the landing switches with no further click, and the launch is then done", async () => {
  const a = app([vision()]);
  await a.click();
  await a.finish();
  assert.deepEqual(a.switched, ["new"]);
  assert.equal(a.c.DL.ready, null);
  assert.equal(a.c.DL.spotlight, null);
  assert.equal(a.c.modelSpotlightUnfinished(), null);
});

test("a download that fails switches to nothing, and its Retry keeps the projector but asks", async () => {
  const a = app([vision()]);
  await a.click();
  await a.finish({ ok: false, error: "offline" });
  assert.equal(a.switched.length, 0);
  assert.equal(a.c.DL.spotlight, null);
  assert.equal(a.c.DL.failed[0].kind, "weights");
  a.c.dlRetry(a.c.DL.failed[0].n);
  await tick();
  assert.deepEqual(a.pulls[1], { id: "new", opts: { trigger: "spotlight", mmproj: true } });
  await a.finish();
  assert.equal(a.switched.length, 0);
  assert.equal(a.c.DL.ready.id, "new");
});

test("a projector the agent skipped is a failed row and no start; Retry fetches it again", async () => {
  const a = app([vision()]);
  await a.click();
  await a.finish({ projectorSkipped: true });
  assert.equal(a.switched.length, 0);
  assert.equal(a.c.DL.ready, null);
  assert.equal(a.c.DL.landed, null);
  assert.equal(a.c.DL.spotlight, null);
  assert.equal(a.c.DL.failed.length, 1);
  assert.equal(a.c.DL.failed[0].kind, "projector");
  assert.match(a.c.DL.failed[0].error, /text only/);
  assert.match(a.c.DL.failed[0].error, /not started.*You can still pick this model for text\.$/, "ATO-1371: still a choice for text");
  assert.equal(a.c.modelSpotlightUnfinished(), "new", "still owed");
  a.c.dlRetry(a.c.DL.failed[0].n);
  await tick();
  assert.deepEqual(a.pulls[1], { id: "new", opts: { trigger: "spotlight", mmproj: true } });
});

test("main's skipped-projector test matches the note the agent prints", () => {
  const agent = readFileSync(new URL("../../src/cli/models-downloads.ts", import.meta.url), "utf8");
  assert.match(agent, /`note: projector download failed \(/);
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.ok(main.includes("/^note: projector download failed/m"));
});

test("Cancel switches to nothing and the card comes back", async () => {
  const a = app([vision()]);
  await a.click();
  a.c.dlCancel();
  await a.finish({ ok: false, error: "killed" });
  assert.equal(a.switched.length, 0);
  assert.equal(a.c.DL.spotlight, null);
  assert.equal(a.c.DL.failed.length, 0);
  assert.equal(a.c.modelSpotlightNow().id, "new");
});

test("after an interruption with the weights on disk the card returns and finishes the job", async () => {
  const a = app([vision({ downloaded: true })]);
  assert.equal(a.c.modelSpotlightNow(), null, "on disk and never pressed: the launch was had");
  a.c.modelSpotlightMark("new");
  assert.equal(a.c.modelSpotlightNow().id, "new");
  await a.click();
  assert.deepEqual(a.pulls, [{ id: "new", opts: { trigger: "spotlight", mmproj: true } }]);
  await a.finish();
  assert.deepEqual(a.switched, ["new"]);
  assert.equal(a.c.modelSpotlightUnfinished(), null);
});

test("no second card while the click waits for a turn", async () => {
  const a = app([vision()]);
  await a.click();
  a.c.turn = true;
  await a.finish();
  assert.equal(a.c.DL.deferred, "new");
  assert.equal(a.c.modelSpotlightNow(), null);
});

test("a running turn is not interrupted: the switch happens when it ends", async () => {
  const a = app([vision()]);
  await a.click();
  a.c.turn = true;
  await a.finish();
  assert.equal(a.switched.length, 0);
  a.c.obFlushDeferredActivate();
  await tick();
  assert.equal(a.switched.length, 0, "still running");
  a.c.turn = false;
  a.c.obFlushDeferredActivate();
  await tick();
  assert.deepEqual(a.switched, ["new"]);
});

test("a model picked during the download or during the wait is not overridden", async () => {
  const during = app([vision()]);
  await during.click();
  during.c.route = "local:other";
  await during.finish();
  assert.equal(during.switched.length, 0);
  assert.equal(during.c.DL.ready.id, "new");

  const waiting = app([vision()]);
  await waiting.click();
  waiting.c.turn = true;
  await waiting.finish();
  waiting.c.turn = false;
  waiting.c.route = "local:other";
  waiting.c.obFlushDeferredActivate();
  await tick();
  assert.equal(waiting.switched.length, 0);
  assert.equal(waiting.c.DL.ready.id, "new");
  assert.equal(waiting.c.DL.deferred, null);
});

test("with no route known at the click, it asks", async () => {
  const a = app([vision()]);
  a.c.route = null;
  await a.click();
  await a.finish();
  assert.equal(a.switched.length, 0);
  assert.equal(a.c.DL.ready.id, "new");
});

test("no card while the starter model comes down", () => {
  const a = app([vision()]);
  assert.equal(a.c.modelSpotlightNow().id, "new");
  a.c.STARTER.phase = "downloading";
  assert.equal(a.c.modelSpotlightNow(), null);
});

test("connected to another computer's agent, a click starts nothing and the card goes", async () => {
  const a = app([vision()]);
  a.c.BR.modelSpotlightIds = async () => [];
  await a.click();
  assert.equal(a.pulls.length, 0);
  assert.equal(a.c.DL.spotlight, null);
  assert.equal(a.c.modelSpotlightNow(), null);
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.ok(main.includes("client.isRemote ? [] : spotlightIds()"));
});
