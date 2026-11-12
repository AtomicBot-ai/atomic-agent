// ATO-1346, ATO-1393: an approval whose category had no entry in the
// renderer's word tables showed its raw id ("shell_dangerous",
// "screen_capture") in the chat line and the Details badge. Every category
// the agent can send (approval-level.ts APPROVAL_CATEGORY_LABELS) now has
// words in all three tables.
//
// Both files are read as text; no deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const agent = readFileSync(new URL("../../src/approval/approval-level.ts", import.meta.url), "utf8");

function agentLabels() {
  const at = agent.indexOf("export const APPROVAL_CATEGORY_LABELS");
  assert.ok(at >= 0, "APPROVAL_CATEGORY_LABELS is in approval-level.ts");
  const body = agent.slice(agent.indexOf("{", at) + 1, agent.indexOf("\n};", at));
  return Object.fromEntries([...body.matchAll(/^\s*([a-z_]+): "([^"]*)",/gm)].map((m) => [m[1], m[2]]));
}

function table(name) {
  const at = renderer.indexOf("\nconst " + name + " = {");
  assert.ok(at >= 0, name + " is a top-level const in renderer.js");
  const text = renderer.slice(at + 1, renderer.indexOf("\n};", at) + 3);
  const c = vm.createContext({});
  vm.runInContext(text.replace(/^const /, "var "), c);
  return c[name];
}

const labels = agentLabels();
const categories = Object.keys(labels);
const has = (t, id) => typeof t[id] === "string" && t[id].trim() !== "";

test("the agent's category list is read", () => {
  assert.ok(categories.length >= 20, "found " + categories.length);
  for (const id of ["shell_dangerous", "screen_capture", "hook_ask", "other"]) assert.ok(categories.includes(id), id);
});

for (const name of ["CATEGORY_PLAIN", "CATEGORY_LABEL"]) {
  test(name + " has words for every agent category", () => {
    const t = table(name);
    assert.deepEqual(categories.filter((id) => !has(t, id)), []);
  });
}

test("APPR_FALLBACK has words for every agent category but other", () => {
  // `other` falls through to "go ahead" on purpose.
  const t = table("APPR_FALLBACK");
  assert.deepEqual(categories.filter((id) => id !== "other" && !has(t, id)), []);
});

test("CATEGORY_LABEL matches the agent's own label", () => {
  const t = table("CATEGORY_LABEL");
  for (const id of categories) assert.equal(t[id], labels[id], id);
});
