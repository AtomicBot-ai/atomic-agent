// ATO-753: the download card's Retry for the local engine. Settings' engine
// install and main's launch install hold the XPULL slot as a `runtime` pull
// named "the local engine". Retry used to send that name to `models pull`,
// which main refuses as a model id ("cannot start the download"), so it
// never worked and buried the install's own error. It must run the engine
// install (`models update`) again.
//
// renderer.js is read as text: its top-level functions and the XPULL
// subscriber run in a vm context with the bridge stubbed. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

/** A top-level `function name(…) {…}`, up to its closing brace at column 0. */
function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  if (at < 0) return null;
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

function fixture() {
  let listener = null;
  const pulls = [];
  const installs = [];
  const c = vm.createContext({
    DL: { job: null, failed: [], failSeq: 0, runSeq: 0, queue: [], preparing: false, projector: null,
      landed: null, activateAfter: null, switchAfter: null, ready: null },
    XPULL: { key: null },
    SEL: { pulling: null },
    ENGF: { f: null, said: 0, dismissed: 0, fresh: false },
    LLMP: { pulling: { kind: "runtime", id: "the local engine", launch: true }, pullLog: [], busy: false, msg: null, statusErr: null },
    BR: {
      onPull: (f) => { listener = f; },
      modelsPull: (id) => { pulls.push(id); return Promise.resolve({ ok: false, error: "cannot start the download" }); },
      modelsPullEmbedding: (id) => { pulls.push(id); return Promise.resolve({ ok: true }); },
      modelsUpdateStream: (...args) => { installs.push(args); return Promise.resolve({ ok: true }); },
    },
    obSetupPullFailed() {}, render() {}, renderDlcard() {}, llmRepaint() {}, llmVisible: () => true,
    toast() {}, appSay() {}, selPull() {}, dlBusy: () => false, dlChipBusy: () => false, dlStart() {},
    dlRateStep() {}, composerEngineId: () => "atomic-core", llmBackendUpdate() {}, llmFail: (w) => w,
    llmRunningWord: () => "a model", setTimeout: () => 0,
  });
  for (const name of ["dlFail", "dlFailClear", "dlRequeue", "dlRetry", "xpullReset", "xpullOwner",
    "xpullRetry", "llmPull", "llmEngineInstall"]) {
    const text = fn(name);
    if (text) vm.runInContext(text, c);
  }
  const a = source.indexOf("if (BR) {\n  /* The XPULL slot's subscriber.");
  assert.ok(a > 0, "the XPULL subscriber is where this test reads it");
  vm.runInContext(source.slice(a, source.indexOf("\n}\n", a) + 2), c);
  assert.equal(typeof listener, "function");
  /** The engine's pull ends with ok:false; then the LLMP subscriber lets go of it. */
  const fail = (error) => { listener({ done: true, ok: false, error }); c.LLMP.pulling = null; };
  return { c, fail, pulls, installs };
}

test("Retry on a failed local engine download runs the engine install again, not a model pull", () => {
  const { c, fail, pulls, installs } = fixture();
  fail("Atomic Core download failed: socket hang up");
  assert.equal(c.DL.failed.length, 1);
  assert.equal(c.DL.failed[0].kind, "runtime");
  assert.match(c.DL.failed[0].error, /socket hang up/);

  c.dlRetry(c.DL.failed[0].n);
  assert.deepEqual(pulls, [], "the engine is not a model: no `models pull the local engine`");
  assert.deepEqual(installs, [["settings"]]);
  assert.deepEqual({ kind: c.LLMP.pulling.kind, id: c.LLMP.pulling.id }, { kind: "runtime", id: "the local engine" });

  // A second failure is the engine's own error on the card, not main's refusal.
  fail("Atomic Core download failed: 503");
  assert.equal(c.DL.failed.length, 1);
  assert.equal(c.DL.failed[0].error, "Atomic Core download failed: 503");
});

test("the recovery card's Retry through that row asks for a fresh install, once", () => {
  const { c, fail, pulls, installs } = fixture();
  fail("Atomic Core did not become ready.");
  c.ENGF.fresh = true;   // engfAct: a setup runtime row exists, so it goes through dlRetry
  c.dlRetry(c.DL.failed[0].n);
  assert.deepEqual(pulls, []);
  assert.deepEqual(JSON.parse(JSON.stringify(installs)), [["settings", { fresh: true }]]);
  assert.equal(c.ENGF.fresh, false);
});

test("a model's failed download still retries as a model pull", () => {
  const { c, fail, pulls, installs } = fixture();
  c.LLMP.pulling = { kind: "chat", id: "qwen3.5-9b" };
  fail("socket hang up");
  c.dlRetry(c.DL.failed[0].n);
  assert.deepEqual(pulls, ["qwen3.5-9b"]);
  assert.deepEqual(installs, []);
});
