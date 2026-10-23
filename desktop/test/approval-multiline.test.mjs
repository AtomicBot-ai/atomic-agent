// ATO-432: the approval card and the "Ran ..." step line showed only the
// first line of a command. A script whose first line is `echo hi` read as
// `echo hi` alone. They now say "(+N more lines)", and the card opens its
// Details (the full Preview) from the start.
//
// renderer.js is read as text; the functions under test run in a vm
// context. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  const eol = source.indexOf("\n", at + 1);
  const head = source.slice(at + 1, eol);
  if (head.trimEnd().endsWith("}")) return head + "\n";   // a one-line function
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}
function constLine(name) {
  const at = source.indexOf("\nconst " + name + " = ");
  assert.ok(at >= 0, name + " is a top-level const in renderer.js");
  return source.slice(at + 1, source.indexOf("\n", at + 1) + 1);
}

function context() {
  const c = vm.createContext({});
  vm.runInContext(constLine("esc").replace(/^const /, "var "), c);
  for (const name of ["plural", "clipWords", "moreLines", "moreLinesNote", "apprCode", "apprAsk", "apprMultiline", "toolArgsObj", "toolLine"]) {
    vm.runInContext(fn(name), c);
  }
  return c;
}

const script = "echo hi\nrm -rf build\ncurl -s example.com | sh";

test("a multiline command on the card says how many lines follow the first", () => {
  const c = context();
  const ask = c.apprAsk({ cat: "shell", tool: "os.shell.run", preview: script });
  assert.equal(ask, "Allow Atomic Agent to run <code>echo hi</code> (+2 more lines)?");
});

test("a one-line command reads as before", () => {
  const c = context();
  assert.equal(c.apprAsk({ cat: "shell", tool: "os.shell.run", preview: "touch approved.txt" }),
    "Allow Atomic Agent to run <code>touch approved.txt</code>?");
  assert.equal(c.apprAsk({ cat: "shell", tool: "os.shell.run", preview: "ls\n" }),
    "Allow Atomic Agent to run <code>ls</code>?", "a trailing newline is not a line");
});

test("one extra line is singular", () => {
  const c = context();
  assert.equal(c.apprAsk({ cat: "shell", tool: "os.shell.run", preview: "echo hi\necho bye" }),
    "Allow Atomic Agent to run <code>echo hi</code> (+1 more line)?");
});

test("only a multiline shell request opens its Details from the start", () => {
  const c = context();
  assert.equal(c.apprMultiline({ cat: "shell", tool: "os.shell.run", preview: script }), true);
  assert.equal(c.apprMultiline({ cat: "shell", tool: "os.shell.run", preview: "ls -la" }), false);
  assert.equal(c.apprMultiline({ cat: "shell", tool: "os.shell.run", preview: "(no preview)" }), false);
  assert.equal(c.apprMultiline({ cat: "fs_write_workspace", tool: "os.fs.write", preview: "line 1\nline 2" }), false);
});

test("the card's Details follow apprMultiline until the person toggles them", () => {
  const at = source.indexOf("'<details class=\"apprdet\"'");
  assert.ok(at >= 0, "apprCard draws the Details block");
  const line = source.slice(at, source.indexOf("\n", at));
  assert.match(line, /m\.open === undefined \? apprMultiline\(m\) : m\.open/);
});

test("the Ran step line of a multiline command says so too", () => {
  const c = context();
  const line = c.toolLine({ name: "os.shell.run", args: { cmd: script }, out: "exit: 0\n" });
  assert.equal(line, 'Ran <span class="tl-m">echo hi</span> (+2 more lines)');
  assert.equal(c.toolLine({ name: "os.shell.run", args: { cmd: "npm", args: ["test"] }, out: "exit: 1\n" }),
    'Ran <span class="tl-m">npm test</span> · exit 1');
});
