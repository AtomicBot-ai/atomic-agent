// The build step for the voice helper: skip off macOS / without swiftc /
// on purpose, otherwise compile (and a compile error fails the build).
// Run: npm run test:unit (no build needed: the module is plain ESM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileFailureMessage, speechHelperPlan, speechHelperTarget } from "../scripts/speech-helper-plan.mjs";

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

test("the helper is compiled for the Mac it is built on (ATO-1506)", () => {
  assert.equal(speechHelperTarget("arm64"), "arm64-apple-macos26.0");
  assert.equal(speechHelperTarget("x64"), "x86_64-apple-macos26.0");
});

test("ATO-2499: the small helpers are built for this build's arch at macOS 14, Show once's helper among them", async () => {
  const { smallHelpers } = await import("../scripts/speech-helper-plan.mjs");
  const arm = smallHelpers("arm64");
  assert.deepEqual(arm.map((h) => h.name), ["atomic-fn-key", "atomic-show-once"]);
  for (const h of arm) assert.equal(h.target, "arm64-apple-macos14.0");
  // The Intel job: an arm64 Fn watcher would not start on an Intel Mac.
  for (const h of smallHelpers("x64")) assert.equal(h.target, "x86_64-apple-macos14.0");
  for (const h of arm) assert.ok(h.without.length > 20, `${h.name} says what is lost without it`);
});

test("ATO-2499: the packaged Mac app carries Show once's helper next to the Fn watcher", async () => {
  const { createRequire } = await import("node:module");
  const config = createRequire(import.meta.url)("../electron-builder.cjs");
  const res = (config.mac && config.mac.extraResources) || [];
  const to = res.map((r) => (typeof r === "string" ? r : r.to));
  assert.ok(to.includes("native/atomic-fn-key"));
  assert.ok(to.includes("native/atomic-show-once"));
});
