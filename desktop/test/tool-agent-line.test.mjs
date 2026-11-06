// ATO-962: a tool the renderer's own table has no words for (an MCP or
// Composio tool, a new one) took the bare "Used <name>". The agent now
// sends its own past-tense line on `tool_progress` (`done_line`, from
// src/tools/describe-tool-call.ts); the card keeps it as `doneLine` and
// toolLine falls back to it. toolTense still words it per state.
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
  if (head.trimEnd().endsWith("}")) return head + "\n";
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
  // toolPath's surroundings: no open workspace.
  vm.runInContext("var S = { live: {} }; var WORKSPACE = ''; function wsName(p) { return p; }", c);
  for (const name of ["plural", "clipWords", "moreLines", "moreLinesNote", "toolArgsObj", "toolPath", "toolWords", "toolVerb", "toolLine", "toolTense"]) {
    vm.runInContext(fn(name), c);
  }
  return c;
}

test("an unknown tool takes the agent's line when it sent one", () => {
  const c = context();
  const m = { name: "mcp.github.create_issue", args: "{}", doneLine: "Used github: create issue" };
  assert.equal(c.toolLine(m), "Used github: create issue");
  assert.equal(c.toolTense(c.toolLine(m), "run"), "Using github: create issue");
  assert.equal(c.toolTense(c.toolLine(m), "err"), "Couldn’t use github: create issue");
});

test("without the agent's line it reads as before", () => {
  const c = context();
  assert.equal(c.toolLine({ name: "mcp.github.create_issue", args: "{}" }), "Used github create issue");
});

test("the renderer's own words win for a tool it knows", () => {
  const c = context();
  const m = { name: "os.fs.edit", args: { path: "notes.md" }, doneLine: "Edited notes.md" };
  assert.match(c.toolLine(m), /^Edited <span class="tl-m">notes\.md<\/span>$/);
});

test("the agent's line is escaped", () => {
  const c = context();
  assert.equal(c.toolLine({ name: "x.y", args: "{}", doneLine: "Used <b>x</b>" }), "Used &lt;b&gt;x&lt;/b&gt;");
});

test("the verbs the agent's lines start with have tenses", () => {
  const c = context();
  for (const [line, running] of [["Found the project", "Finding the project"], ["Stopped process 42", "Stopping process 42"],
    ["Created a pull request", "Creating a pull request"], ["Extracted a.zip", "Extracting a.zip"]]) {
    assert.equal(c.toolTense(line, "run"), running);
  }
});

test("the live card keeps done_line from tool_progress", () => {
  const at = source.indexOf("if (ev.kind === 'tool_progress') {");
  assert.ok(at >= 0);
  const block = source.slice(at, source.indexOf("\n  }\n", at));
  assert.match(block, /pick\(ev\.payload, 'done_line'\)/);
  assert.match(block, /doneLine:/);
});
