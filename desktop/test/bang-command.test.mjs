// ATO-1238 (first slice): `!command` in the composer opens Terminal in the
// chat's folder with the command typed, not run. Pure parts from
// bang-command.js; the submit() hook is checked in renderer.js as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const B = createRequire(import.meta.url)("../renderer/bang-command.js");
const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");

test("a `!command` gives the command, trimmed", () => {
  assert.equal(B.bangCommandOf("!ls -la"), "ls -la");
  assert.equal(B.bangCommandOf("  ! git status  "), "git status");
  assert.equal(B.bangCommandOf("!npm run build\n"), "npm run build");
  assert.equal(B.bangCommandOf("!echo a\r\necho b"), "echo a\necho b");
});

test("ordinary text is not a command", () => {
  for (const t of ["", "!", "!!", "!! ls", "!   ", "hello !ls", "what does !ls do?", null, undefined]) {
    assert.equal(B.bangCommandOf(t), null, String(t));
  }
});

test("only on macOS and only with the Terminal bridge", () => {
  const br = { terminalOpenWithCommand() {} };
  assert.equal(B.bangTerminalOkFor("darwin", br), true);
  assert.equal(B.bangTerminalOkFor("win32", br), false);
  assert.equal(B.bangTerminalOkFor("linux", br), false);
  assert.equal(B.bangTerminalOkFor("darwin", {}), false);
  assert.equal(B.bangTerminalOkFor("darwin", null), false);
});

test("submit() sends a `!command` to Terminal before the message is built", () => {
  const at = renderer.indexOf("\nfunction submit(");
  const body = renderer.slice(at, renderer.indexOf("\n}\n", at));
  const hook = body.indexOf("bangCommandOf(typed)");
  assert.ok(hook > 0, "submit asks bangCommandOf");
  assert.ok(hook < body.indexOf("attComposeMessage("), "before attachments are folded in");
  assert.ok(hook < body.indexOf("startsWith('/')"), "before slash commands");
  assert.match(body.slice(hook, hook + 300), /bangOpen\(/);
  assert.match(body.slice(hook - 200, hook), /typeof preparedSkillText !== 'string'/);
});

test("the page loads bang-command.js before renderer.js", () => {
  const a = html.indexOf('<script src="bang-command.js"></script>');
  assert.ok(a > 0 && a < html.indexOf('<script src="renderer.js"></script>'));
});
