// ATO-440 / ATO-820: after 20 s on the closing screen, "Open the app now"
// (and Escape) lets the person out. Leaving used to cancel the settle still
// out: no closing stamp (setup opened again next launch), no agent restart,
// and nothing counted. Now the settle goes on behind the closed overlay,
// raises no more offers, writes the stamp, restarts the agent, and the way
// out is the `onboarding:openNow` act.
//
// renderer.js is read as text; the onboarding functions run in a vm context
// with the bridge stubbed. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const acts = readFileSync(new URL("../renderer/analytics-acts.js", import.meta.url), "utf8");

function fn(name) {
  let at = source.indexOf("\nfunction " + name + "(");
  if (at < 0) at = source.indexOf("\nasync function " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

function fixture({ readiness } = {}) {
  const writes = [];
  const calls = { restart: 0, toasts: [], acts: [], offers: 0, detect: 0 };
  let release;
  const gate = new Promise((r) => { release = r; });
  const c = vm.createContext({
    OB: { open: true, step: "finished", settleSlow: true, settling: false, outcome: "cloud", openGen: 1,
      handOver: false, skipSecondOffer: false, testClose: false, restarted: false, leftEarly: false },
    OB_STAMPED: {}, OB_STAMP_LOG: [], OB_SETTLE_SLOW_TIMER: null,
    BR: {
      configSet: (key, value) => { writes.push(key); return Promise.resolve({ ok: true }); },
      restart: () => { calls.restart++; return Promise.resolve({}); },
    },
    ANX: { via() {} },
    act: (a) => { calls.acts.push(a); },
    obReadiness: async () => { if (readiness === "slow") await gate; return { cloudReady: true, localReady: true, stamps: {} }; },
    obDecideSecondBackend: () => { calls.offers++; return { kind: "local" }; },
    obDetectAgents: async () => { calls.detect++; return [{ id: "tui" }]; },
    obDispatch() {}, obStampOnce() {}, obSetupPullId: () => null, obSetupPullRemember() {},
    obLocalIsSecondBackend: () => false, obSetupPullNote() {}, obSetupPullForget() {},
    obClosingToast: () => ["Setup complete", "Restarting the agent…"], obClosingToastCarried: () => false,
    toast: (t) => { calls.toasts.push(t); }, render() {}, refreshLiveConfig() {}, applyStatus() {}, obSkyStop() {},
    clearTimeout() {},
  });
  for (const name of ["obSettleSlowClear", "obFinishedKey", "obOpenNow", "obSettle"]) vm.runInContext(fn(name), c);
  return { c, writes, calls, release };
}

const tick = () => new Promise((r) => setImmediate(r));

test("Escape on the slow closing screen goes out through the onboarding:openNow act", () => {
  const { c, calls } = fixture();
  assert.equal(c.obFinishedKey("", { escape: true }), true);
  assert.deepEqual(calls.acts, ["onboarding:openNow"]);
});

test("leaving while the settle is still out lets it finish: stamp written, agent restarted, no offers", async () => {
  const { c, writes, calls, release } = fixture({ readiness: "slow" });
  const settle = c.obSettle();                  // the settle obAfterStep started, waiting on the readiness reads
  c.obOpenNow();
  assert.equal(c.OB.open, false, "the overlay closes at once");
  assert.equal(c.OB.leftEarly, true);
  release();
  await settle;
  await tick();
  assert.deepEqual(writes, ["tui.onboarding.completedAt"]);
  assert.equal(calls.restart, 1);
  assert.equal(calls.offers, 0, "no second-backend offer behind a closed overlay");
  assert.equal(calls.detect, 0, "no import scan behind a closed overlay");
});

test("leaving with no settle out starts one that writes the stamp and restarts the agent", async () => {
  const { c, writes, calls } = fixture();
  c.obOpenNow();
  await tick(); await tick();
  assert.deepEqual(writes, ["tui.onboarding.completedAt"]);
  assert.equal(calls.restart, 1);
});

test("Open the app now does nothing before the slow line is up", async () => {
  const { c, writes } = fixture();
  c.OB.settleSlow = false;
  c.obOpenNow();
  await tick();
  assert.equal(c.OB.open, true);
  assert.deepEqual(writes, []);
});

test("the act is on the analytics allowlist, and the button uses it", () => {
  assert.match(acts, /onboarding:\{[^}]*openNow:L/);
  assert.match(source, /obBtn\('open:now', 'Open the app now'/);
  assert.match(source, /if \(spec === 'open:now'\) \{ act\('onboarding:openNow'\); return; \}/);
  assert.match(source, /if \(a === 'onboarding:openNow'\) \{ obOpenNow\(\); return; \}/);
});
