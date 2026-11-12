// ATO-1102: "Test skill" on the skill card. Renderer helpers, the main-side
// probe/argv/parsing (against the built output), and the wiring pins.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { skillEvalDuration, skillEvalTokens, skillEvalSummary, skillEvalHTML } = require("../renderer/workspace-skills.js");
const {
  skillEvalSupported, skillEvalTasksFile, skillEvalArgs, parseSkillEvalOutput,
} = require("../out/main/skill-eval-cli.js");

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const side = (passed, total, seconds = null, tokens = null) => ({ passed, total, seconds, tokens });
const result = (w, wo) => ({ skill: "guide", withSkill: w, withoutSkill: wo, tasks: [] });

test("durations and token counts read in plain words", () => {
  assert.equal(skillEvalDuration(42.4), "42 s");
  assert.equal(skillEvalDuration(72), "1 min 12 s");
  assert.equal(skillEvalDuration(120), "2 min");
  assert.equal(skillEvalDuration(3725), "1 h 2 min");
  assert.equal(skillEvalDuration(null), null);
  assert.equal(skillEvalTokens(640), "640 tokens");
  assert.equal(skillEvalTokens(18200), "18.2k tokens");
  assert.equal(skillEvalTokens(12000), "12k tokens");
  assert.equal(skillEvalTokens(250400), "250k tokens");
  assert.equal(skillEvalTokens(undefined), null);
});

test("the summary compares the two runs", () => {
  const helped = skillEvalSummary(result(side(4, 5, 72.4, 18200), side(2, 5, 58.1, 12100)));
  assert.deepEqual(helped.lines, [
    { label: "With the skill", text: "4 of 5 tasks passed (80%), 1 min 12 s, 18.2k tokens" },
    { label: "Without it", text: "2 of 5 tasks passed (40%), 58 s, 12.1k tokens" },
  ]);
  assert.equal(helped.verdict, "The skill helped: 2 more tasks passed. With the skill: 14 s slower, 6.1k more tokens.");
});

test("worse, equal, uneven and empty runs say so", () => {
  assert.equal(skillEvalSummary(result(side(1, 3), side(2, 3))).verdict, "The skill made it worse: 1 fewer task passed.");
  assert.equal(skillEvalSummary(result(side(3, 3, 10, 500), side(3, 3, 20, 900))).verdict,
    "No difference in passed tasks. With the skill: 10 s faster, 400 fewer tokens.");
  assert.match(skillEvalSummary(result(side(2, 4), side(2, 5))).verdict, /cannot be compared/);
  assert.equal(skillEvalSummary(result(side(0, 0), side(0, 0))).verdict, "The task set has no tasks.");
  // Unknown time or tokens are left out, not shown as zero.
  assert.equal(skillEvalSummary(result(side(1, 2), side(1, 2))).lines[0].text, "1 of 2 tasks passed (50%)");
});

test("the card shows nothing until main says the skill can be tested", () => {
  assert.equal(skillEvalHTML({ name: "guide", probe: null }, esc), "");
  assert.equal(skillEvalHTML({ name: "guide", probe: { ok: true, available: false, reason: "agent" } }, esc), "");
  assert.equal(skillEvalHTML({ name: "guide", probe: { ok: true, available: false, reason: "tasks" } }, esc), "");
  const ready = skillEvalHTML({ name: "guide", probe: { ok: true, available: true }, runningName: null, outcome: null }, esc);
  assert.match(ready, /data-act="skills:test:guide"[^>]*>Test skill</);
  assert.doesNotMatch(ready, /disabled/);
});

test("running, cancelling, another run and the outcomes", () => {
  const probe = { ok: true, available: true };
  const running = skillEvalHTML({ name: "guide", probe, runningName: "guide", cancelling: false }, esc);
  assert.match(running, /tk-spin/);
  assert.match(running, /data-act="skills:testCancel">Cancel</);
  assert.doesNotMatch(running, /skills:test:guide/);
  assert.match(skillEvalHTML({ name: "guide", probe, runningName: "guide", cancelling: true }, esc), /Stopping the test.*disabled>Cancel/s);
  const other = skillEvalHTML({ name: "guide", probe, runningName: "other" }, esc);
  assert.match(other, /skills:test:guide" disabled/);
  assert.match(other, /Another skill test is running/);
  const done = skillEvalHTML({ name: "guide", probe, outcome: { ok: true, result: result(side(2, 2), side(1, 2)) } }, esc);
  assert.match(done, /<b>With the skill:<\/b> 2 of 2 tasks passed \(100%\)/);
  assert.match(done, /The skill helped: 1 more task passed\./);
  assert.match(skillEvalHTML({ name: "guide", probe, outcome: { ok: false, cancelled: true } }, esc), /Test stopped\./);
  assert.match(skillEvalHTML({ name: "guide", probe, outcome: { ok: false, error: "no model <set>" } }, esc), /tk-help--err">no model &lt;set&gt;</);
  // No long dashes in what the person reads.
  for (const html of [running, other, done]) assert.doesNotMatch(html, /—/);
});

test("main: probe, task file and argv", () => {
  assert.equal(skillEvalSupported("Subcommands:\n  show <name>   Print SKILL.md\n  eval <name> --tasks <file> [--json]   Run a task set\n"), true);
  assert.equal(skillEvalSupported("Subcommands:\n  show <name>   Print SKILL.md\n  evaluate is not here\n"), false);
  assert.equal(skillEvalSupported("unknown subcommand: eval\n"), false);
  const dir = join("/skills", "guide");
  const md = join(dir, "SKILL.md");
  assert.equal(skillEvalTasksFile(md, (p) => p === join(dir, "tasks.yml")), join(dir, "tasks.yml"));
  assert.equal(skillEvalTasksFile(md, () => true), join(dir, "tasks.yaml"));
  assert.equal(skillEvalTasksFile(md, () => false), null);
  assert.equal(skillEvalTasksFile("", () => true), null);
  assert.deepEqual(skillEvalArgs("guide", "/s/tasks.yaml"), ["skill", "eval", "guide", "--tasks", "/s/tasks.yaml", "--json"]);
});

test("main: the eval JSON is read whole, pretty or after log lines", () => {
  const doc = { skill: "guide", withSkill: { passed: 4, total: 5, seconds: 72.4, tokens: 18200 }, withoutSkill: { passed: 2, total: 5, seconds: null },
    tasks: [{ id: "t1", withSkill: { passed: true }, withoutSkill: { passed: false } }, { withSkill: true }] };
  const expected = { ok: true, result: { skill: "guide",
    withSkill: { passed: 4, total: 5, seconds: 72.4, tokens: 18200 }, withoutSkill: { passed: 2, total: 5, seconds: null, tokens: null },
    tasks: [{ id: "t1", withSkill: true, withoutSkill: false }, { id: "2", withSkill: true, withoutSkill: null }] } };
  assert.deepEqual(parseSkillEvalOutput(JSON.stringify(doc, null, 2), "guide"), expected);
  assert.deepEqual(parseSkillEvalOutput("loading model…\n" + JSON.stringify(doc) + "\n", "guide"), expected);
  assert.equal(parseSkillEvalOutput(JSON.stringify({ ...doc, skill: undefined }), "fallback").result.skill, "fallback");
});

test("main: anything else is an error, never a made-up result", () => {
  assert.equal(parseSkillEvalOutput("", "g").ok, false);
  assert.equal(parseSkillEvalOutput("4 of 5 passed\n", "g").ok, false);
  assert.equal(parseSkillEvalOutput("{not json", "g").ok, false);
  assert.equal(parseSkillEvalOutput(JSON.stringify({ withSkill: { passed: 6, total: 5 }, withoutSkill: { passed: 1, total: 5 } }), "g").ok, false);
  assert.equal(parseSkillEvalOutput(JSON.stringify({ withSkill: { passed: 1, total: 5 } }), "g").ok, false);
  assert.equal(parseSkillEvalOutput(JSON.stringify({ withSkill: { passed: "1", total: 5 }, withoutSkill: { passed: 1, total: 5 } }), "g").ok, false);
});

test("wiring: preload, main and the skill card", () => {
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /skillEvalProbe: \(name: string\) => ipcRenderer\.invoke\("cli:skillEvalProbe", name\)/);
  assert.match(preload, /skillEvalRun: \(name: string\) => ipcRenderer\.invoke\("cli:skillEvalRun", name\)/);
  assert.match(preload, /skillEvalCancel: \(\) => ipcRenderer\.invoke\("cli:skillEvalCancel"\)/);
  const ipc = readFileSync(new URL("../main/skill-eval-ipc.ts", import.meta.url), "utf8");
  for (const ch of ["cli:skillEvalProbe", "cli:skillEvalRun", "cli:skillEvalCancel"]) assert.ok(ipc.includes(`ipcMain.handle("${ch}"`), ch);
  assert.match(readFileSync(new URL("../main/main.ts", import.meta.url), "utf8"), /wireSkillEvalIpc\(\{ cwd: \(\) => client\.status\.workingDir \}\)/);
  const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(renderer, /\+ skillEvalHTML\(\{name, probe:SKE\.probeName === name \? SKE\.probe : null/);
  assert.match(renderer, /if \(verb === 'test'\) \{ const name = sel\(\); if \(name\) skeRun\(name\); return; \}/);
  assert.match(renderer, /SKP\.lastError = null; render\(\);\n  skeProbe\(name\);/);
});
