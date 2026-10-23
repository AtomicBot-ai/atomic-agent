// Unit tests for renderer/task-ask.js (ATO-519).
// Run: npm run test:unit
// A new task starts as one sentence to the agent; the cron form is Set up manually.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const T = createRequire(import.meta.url)("../renderer/task-ask.js");
const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

test("nothing typed sends nothing", () => {
  assert.equal(T.taskAskMessage(""), "");
  assert.equal(T.taskAskMessage("   \n  "), "");
  assert.equal(T.taskAskMessage(null), "");
  assert.equal(T.taskAskMessage(undefined), "");
});

test("the sentence goes out whole, on one line, and asks for a schedule through the task tools", () => {
  const msg = T.taskAskMessage("  every weekday at 9,\n check   the site  ");
  assert.ok(msg.startsWith("Set up a scheduled task: every weekday at 9, check the site\n\n"), msg);
  assert.match(msg, /tasks\.cron/);
  assert.match(msg, /tasks\.schedule/);
  assert.match(msg, /when it runs next/);
});

test("every example is a schedule plus an action and fills a message", () => {
  assert.ok(T.TASK_ASK_EXAMPLES.length >= 2);
  for (const ex of T.TASK_ASK_EXAMPLES) {
    assert.match(ex, /^(every|tomorrow)\b/, ex);
    assert.notEqual(T.taskAskMessage(ex), "");
  }
});

test("no user-facing line uses an em dash", () => {
  const lines = [T.TASK_ASK_PLACEHOLDER, T.TASK_PREVIEW_EMPTY, T.TASK_EMPTY_HINT, T.taskAskMessage("x"), ...T.TASK_ASK_EXAMPLES];
  for (const line of lines) assert.ok(!line.includes("—"), line);
});

test("the preview card no longer says preview unavailable before a schedule is typed", () => {
  assert.ok(!renderer.includes("(preview unavailable)"));
  assert.ok(!renderer.includes("<b>Next firings</b>"));
  assert.match(renderer, /esc\(TASK_PREVIEW_EMPTY\)/);
});

test("a new task opens on the plain-words step, and the manual form is one click away", () => {
  assert.match(renderer, /function tkNewForm\(\) \{[\s\S]*?manual:false, ask:''/);
  assert.match(renderer, /if \(!f\.manual\) return tkAskHTML\(f\);/);
  assert.match(renderer, /data-act="tasks:manual"/);
  assert.match(renderer, /data-act="tasks:plain"/);
  // The sentence goes out as a new chat's first message through the composer's own submit().
  assert.match(renderer, /function tkAsk\(\) \{[\s\S]*?act\('session:new'\);[\s\S]*?submit\(undefined, \{plain:true\}\);/);
  // Files waiting in the composer are not swept into the task request, and a draft in the box survives it.
  assert.match(renderer, /function tkAsk\(\) \{[\s\S]*?const kept = S\.draft[\s\S]*?if \(kept && !S\.draft\)/);
});

test("an empty task list hides filters and search and shows the example hint", () => {
  assert.match(renderer, /const none = !TK\.rows\.length;\s*\n\s*const seg = none \? '' :/);
  assert.match(renderer, /esc\(TASK_EMPTY_HINT\)/);
});

test("index.html loads task-ask.js before renderer.js", () => {
  const index = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const helper = index.indexOf('<script src="task-ask.js">');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="renderer.js">'));
});
