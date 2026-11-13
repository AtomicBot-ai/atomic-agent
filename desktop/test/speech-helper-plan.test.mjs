// The build step for the voice helper: skip off macOS / without swiftc /
// on purpose, otherwise compile (and a compile error fails the build).
// Run: npm run test:unit (no build needed: the module is plain ESM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileFailureMessage, speechHelperPlan } from "../scripts/speech-helper-plan.mjs";

const yes = () => true;
const no = () => false;

test("off macOS it is skipped without asking for swiftc", () => {
  for (const platform of ["win32", "linux"]) {
    let asked = false;
    const plan = speechHelperPlan({ platform, env: {}, hasSource: true, hasSwiftc: () => ((asked = true), true) });
    assert.deepEqual(plan, { action: "skip", reason: "not macOS" });
    assert.equal(asked, false);
  }
});

test("a Mac with swiftc and the source builds it", () => {
  assert.deepEqual(speechHelperPlan({ platform: "darwin", env: {}, hasSource: true, hasSwiftc: yes }), { action: "build" });
});

test("a Mac without swiftc is skipped", () => {
  assert.deepEqual(speechHelperPlan({ platform: "darwin", env: {}, hasSource: true, hasSwiftc: no }), {
    action: "skip",
    reason: "no swiftc",
  });
});

test("no Swift source is skipped", () => {
  assert.equal(speechHelperPlan({ platform: "darwin", env: {}, hasSource: false, hasSwiftc: yes }).action, "skip");
});

test("ATOMIC_SKIP_SPEECH_HELPER opts out, other values do not", () => {
  for (const v of ["1", "true", "YES", " 1 "]) {
    const plan = speechHelperPlan({ platform: "darwin", env: { ATOMIC_SKIP_SPEECH_HELPER: v }, hasSource: true, hasSwiftc: yes });
    assert.equal(plan.action, "skip", v);
  }
  for (const v of ["", "0", "false", undefined]) {
    const plan = speechHelperPlan({ platform: "darwin", env: { ATOMIC_SKIP_SPEECH_HELPER: v }, hasSource: true, hasSwiftc: yes });
    assert.equal(plan.action, "build", String(v));
  }
});

test("the failure message names the opt-out and the first error line", () => {
  const msg = compileFailureMessage(new Error("Command failed: xcrun swiftc\nmore"));
  assert.match(msg, /swiftc failed \(Command failed: xcrun swiftc\)/);
  assert.match(msg, /ATOMIC_SKIP_SPEECH_HELPER=1/);
  assert.doesNotMatch(msg, /more/);
});
