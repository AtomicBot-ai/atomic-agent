// ATO-1390: a read of the agent's own secret file (state/.env, config.json,
// local server keys) asks as `state_secret` at every level below 5. The card
// title keeps only "read <path>", so the card's line under it must say what
// the file is, for the file read and for a shell command naming it.
//
// renderer.js is read as text; apprWhy runs in a vm context. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

function apprWhy(m) {
  const c = vm.createContext({ esc: (s) => String(s), apprCode: (s) => String(s), apprPath: (s) => String(s), VIDEO_PAID_WHY: "" });
  vm.runInContext(fn("apprWhy"), c);
  return c.apprWhy(m);
}

const reason = "read /Users/jane/.atomic-agent/state/.env — the agent's own secret file (API keys, tokens, approval settings); asked every time, never granted for the session";

test("a file read of the agent's own secret file says so on the card", () => {
  const why = apprWhy({ cat: "state_secret", tool: "os.fs.read", reason });
  assert.match(why, /agent's own secret file/);
  assert.match(why, /asks every time/);
});

test("a shell command naming one says the same, not a guard flag", () => {
  const why = apprWhy({ cat: "state_secret", tool: "os.shell.run", reason: "cat state/.env — the agent's own secret file" });
  assert.match(why, /agent's own secret file/);
  assert.doesNotMatch(why, /safety check flagged/);
});

test("other file reads are unchanged", () => {
  assert.equal(apprWhy({ cat: "fs_write", tool: "os.fs.write", reason: "write a.txt" }), "");
});
