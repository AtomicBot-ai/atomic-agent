// ATO-1125: the required-update policy the desktop reads from its feed's
// releaseNotes (main/update-policy.ts), against the built output
// (npm run build first), and the renderer side (renderer/app-update.js in a
// vm, renderer.js read as text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const P = require("../out/main/update-policy.js");
const U = require("../out/main/updater.js");

const line = (json) => `Fixes for long chats.\n\n<!-- atomic-agent-update-policy: ${json} -->\n`;
const reason = (current, latest, notes) => P.requiredUpdate(current, latest, P.parseUpdatePolicy(notes), U.compareVersions);

test("the policy line is read from the feed's notes, string or array", () => {
  assert.deepEqual(P.parseUpdatePolicy(line('{"minimum":"v0.0.7","broken":["0.0.6","nope",3]}')), { minimum: "0.0.7", broken: ["0.0.6"] });
  assert.deepEqual(P.parseUpdatePolicy([{ version: "0.0.8", note: line('{"broken":["0.0.5"]}') }]), { minimum: null, broken: ["0.0.5"] });
});

test("a missing, broken or odd policy line requires nothing (fails open)", () => {
  for (const notes of [null, undefined, "", "just notes", line("{not json"), line("[1,2]"), line('{"minimum":"soon"}'), 42]) {
    assert.deepEqual(P.parseUpdatePolicy(notes), P.EMPTY_UPDATE_POLICY, String(notes));
    assert.equal(reason("0.0.6", "0.0.8", notes), null, String(notes));
  }
});

test("broken and below-minimum, never to a listed or older latest", () => {
  const notes = line('{"minimum":"0.0.7","broken":["0.0.6"]}');
  assert.equal(reason("0.0.6", "0.0.8", notes), "broken");
  assert.equal(reason("0.0.5", "0.0.8", notes), "below-minimum");
  assert.equal(reason("0.0.7", "0.0.8", notes), null);
  assert.equal(reason("0.0.6", "0.0.6", notes), null);
  assert.equal(reason("0.0.5", "0.0.8", line('{"broken":["0.0.5","0.0.8"]}')), null);
});

test("the toast's notes line never shows the hidden policy", () => {
  assert.equal(U.firstNotesLine(`<!-- atomic-agent-update-policy: {"broken":["0.0.6"]} -->\nFixes for long chats.`), "Fixes for long chats.");
});

function rendererUpdates() {
  const renders = [];
  const c = vm.createContext({
    BR: null,
    esc: (s) => String(s),
    ic: (n) => `<i data-ic="${n}"></i>`,
    toastsClearCard: () => {},
    render: () => renders.push(1),
  });
  vm.runInContext(readFileSync(new URL("../renderer/app-update.js", import.meta.url), "utf8"), c);
  return { c, renders };
}

const st = (required, more = {}) => ({ phase: "available", version: "0.0.8", toast: true, required, ...more });

test("below minimum: a warning on the empty chat and in the toast, and the chat starts", () => {
  const { c, renders } = rendererUpdates();
  c.appUpdApply(st("below-minimum"));
  assert.equal(renders.length, 1);
  assert.equal(c.updHoldsNewChat(0, false), false);
  assert.match(c.updRequiredHTML(), /no longer supported/);
  assert.match(c.updRequiredHTML(), /data-act="appupd:update"/);
  assert.match(c.updToastHTML(c.updState()), /Please update Atomic Agent/);
});

test("broken: the empty chat says Update required and no new chat starts", () => {
  const { c } = rendererUpdates();
  c.appUpdApply(st("broken"));
  assert.match(c.updRequiredHTML(), /Update required/);
  assert.match(c.updRequiredHTML(), /data-act="appupd:update"/);
  assert.equal(c.updHoldsNewChat(0, false), true);
  // A chat with messages, and a turn that runs, are never held.
  assert.equal(c.updHoldsNewChat(3, false), false);
  assert.equal(c.updHoldsNewChat(0, true), false);
  // Downloaded: the card offers the restart instead.
  c.appUpdApply(st("broken", { phase: "ready" }));
  assert.match(c.updRequiredHTML(), /data-act="appupd:install"/);
});

test("no policy: no card, nothing held, the usual toast", () => {
  const { c, renders } = rendererUpdates();
  c.appUpdApply(st(null));
  assert.equal(renders.length, 0);
  assert.equal(c.updRequiredHTML(), "");
  assert.equal(c.updHoldsNewChat(0, false), false);
  assert.match(c.updToastHTML(c.updState()), /is available/);
});

test("renderer.js draws the card on the empty chat and asks before a send", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const empty = src.slice(src.indexOf("\nfunction emptyChat("), src.indexOf("\nfunction emptyPlateHTML("));
  assert.match(empty, /updRequiredHTML\(\)/);
  const submit = src.slice(src.indexOf("\nfunction submit("), src.indexOf("\nfunction submit(") + 8000);
  assert.match(submit, /updHoldsNewChat\(S\.log\.length, S\.busy \|\| S\.pending\)/);
});
