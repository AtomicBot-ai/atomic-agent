// ATO-2499 "Show once": the replay check and "Test skill" on a recorded draft.
// main/show-once-skill.ts (a "Check:" per step from the recorded window titles, the
// replay rules that stop at the first mismatch) and renderer/show-once-draft.js (the
// button and the dry-run message of the new chat), against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../out/main/show-once-log.js");
const S = require("../out/main/show-once-skill.js");
const DV = require("../renderer/show-once-draft.js");

const numbers = { name: "Numbers", bundleId: "com.apple.iWork.Numbers", pid: 100 };
const key = (keycode, extra = {}) => ({ kind: "key", at: 0, keycode, meta: false, ctrl: false, alt: false, shift: false, app: numbers, ...extra });
const at = new Date(2026, 10, 28, 11, 0);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function recorded() {
  const log = new L.ShowOnceLog(1);
  log.add(key(31, { meta: true, shift: true, windowTitle: "Budget" })); // shift+cmd+s opens Save As
  log.add({ kind: "window", at: 1, app: numbers, title: "Save As" });
  log.add(key(35, { windowTitle: "Save As" }));
  log.add(key(28, { windowTitle: "Save As" }));
  log.add({ kind: "window", at: 2, app: numbers, title: "Budget copy" });
  return log.steps;
}

test("each step says what the window should be after it, from what the recording heard", () => {
  const steps = recorded();
  assert.equal(S.stepCheck(steps, 0), ' Check: Numbers is in front with the window "Budget".');
  assert.equal(S.stepCheck(steps, 1), ' Check: the window "Save As" is now in front.');
  assert.equal(S.stepCheck(steps, 2), ' Check: the window "Save As" is still in front.');
  assert.equal(S.stepCheck(steps, 3), ' Check: the window "Budget copy" is now in front.');
  assert.equal(S.stepCheck(steps, 9), "");
  assert.equal(S.stepCheck([{ kind: "keys", app: "Numbers", bundleId: "x", keys: "return" }], 0), "", "no title heard, nothing to compare");
  assert.equal(S.stepCheck([{ kind: "protected", app: "1Password" }], 0), "");
});

test("the SKILL.md carries the checks and stops the replay at the first step that does not match", () => {
  const md = S.compileShowOnceSkill(recorded(), at).content;
  assert.ok(md.includes('2. Press `shift+cmd+s` in Numbers (os.screen.key { keys: "shift+cmd+s" }). Check: the window "Save As" is now in front.'));
  assert.ok(md.includes("At the first step that does not match, stop: do not try other clicks."));
  assert.ok(md.includes('"Replay stopped at step N of M: expected ..., saw ..."'));
  assert.ok(md.includes('"Replay check: all M steps matched."'));
  assert.ok(!md.includes("If it does not look the way the next step expects"), "the old loose rule is gone");
});

const draft = { id: "deadbeef", name: "show-once-numbers-20261128-1100",
  draft: { skill: "show-once-numbers-20261128-1100", sources: ["show-once recording"], skillMd: "---\nname: show-once-numbers-20261128-1100\ndescription: \"x\"\n---\n\n# Save a copy\n\n## Steps\n\n1. Do it." } };

test("Test skill: a button in a recorded draft's preview opens a new chat with a dry run of the draft", () => {
  const sent = [];
  const view = DV.createShowOnceDraftView({ api: () => ({}), paint: () => {}, startChat: (t) => sent.push(t) });
  const html = view.html(draft, esc);
  assert.match(html, /data-act="skills:showOnceDraft:test">Test skill</);
  assert.match(DV.showOnceTestHTML({ draft: { sources: ["show-once recording"] } }, esc), /disabled>Test skill/, "not before the draft has loaded");
  view.act("test", draft);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].startsWith('Test the skill draft "show-once-numbers-20261128-1100" once, as a dry run'));
  assert.ok(sent[0].includes("Stop at the first step that does not match"));
  assert.ok(sent[0].endsWith("# Save a copy\n\n## Steps\n\n1. Do it."));
  assert.ok(!sent[0].includes("description:"), "the front matter stays out");
  view.act("test", { ...draft, draft: { ...draft.draft, sources: ["https://e.com"] } });
  view.act("nope", draft);
  assert.equal(sent.length, 1, "only for a Show once draft, only on test");
  const long = DV.showOnceTestMessage("n", "x".repeat(20000));
  assert.ok(long.length < 13000 && long.includes("The rest of the draft was cut"));
});
