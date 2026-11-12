// ATO-1102: "Test skill" on the skill card. Renderer helpers, the main-side
// probe/argv/parsing (against the built output), and the wiring pins.
// The result document is #1307's `atomic-agent.skill-eval/1` (src/skills/eval/README.md).
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { skillEvalDuration, skillEvalTokens, skillEvalCost, skillEvalSummary, skillEvalHTML } = require("../renderer/workspace-skills.js");
const {
  skillEvalSupported, skillEvalTasksFile, skillEvalArgs, parseSkillEvalOutput, skillEvalSavedPath,
} = require("../out/main/skill-eval-cli.js");

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// What main hands the window (SkillEvalResult in main/skill-eval-cli.ts).
const side = (passed, runs, secondsMean = 0, tokens = null, over = {}) =>
  ({ runs, passed, accuracy: runs ? passed / runs : 0, secondsMean, tokens, costUsd: 0, errors: 0, ...over });
const result = (w, wo, over = {}) => ({
  skill: "guide", runId: "r1", complete: true, repeat: 1, with: w, without: wo, perTask: [], approvalsDenied: 0,
  delta: { accuracy: w.accuracy - wo.accuracy, secondsMean: w.secondsMean - wo.secondsMean,
    tokens: w.tokens === null || wo.tokens === null ? null : w.tokens - wo.tokens, costUsd: 0 },
  ...over,
});

test("durations, token counts and cost read in plain words", () => {
  assert.equal(skillEvalDuration(42.4), "42 s");
  assert.equal(skillEvalDuration(72), "1 min 12 s");
  assert.equal(skillEvalDuration(120), "2 min");
  assert.equal(skillEvalDuration(3725), "1 h 2 min");
  assert.equal(skillEvalDuration(null), null);
  assert.equal(skillEvalTokens(640), "640 tokens");
  assert.equal(skillEvalTokens(18200), "18.2k tokens");
  assert.equal(skillEvalTokens(12000), "12k tokens");
  assert.equal(skillEvalTokens(250400), "250k tokens");
  assert.equal(skillEvalTokens(null), null);
  assert.equal(skillEvalCost(0), null); // a local model: nothing to say
  assert.equal(skillEvalCost(null), null);
  assert.equal(skillEvalCost(1.5), "$1.50");
  assert.equal(skillEvalCost(0.004), "$0.0040");
});

test("the summary compares the two variants", () => {
  const helped = skillEvalSummary(result(side(4, 5, 72.4, 18200), side(2, 5, 58.1, 12100)));
  assert.deepEqual(helped.lines, [
    { label: "With the skill", text: "4 of 5 tasks passed (80%), 1 min 12 s per task, 18.2k tokens" },
    { label: "Without it", text: "2 of 5 tasks passed (40%), 58 s per task, 12.1k tokens" },
  ]);
  assert.equal(helped.verdict, "The skill helped: 2 more tasks passed. With the skill: 14 s slower per task, 6.1k more tokens.");
  assert.deepEqual(helped.notes, []);
  assert.match(skillEvalSummary(result(side(1, 2, 5, null, { costUsd: 1.5 }), side(1, 2, 5))).lines[0].text, /, \$1\.50$/);
});

test("worse, equal, uneven, missing and empty runs say so", () => {
  assert.equal(skillEvalSummary(result(side(1, 3), side(2, 3))).verdict, "The skill made it worse: 1 fewer task passed.");
  assert.equal(skillEvalSummary(result(side(3, 3, 10, 500), side(3, 3, 20, 900))).verdict,
    "No difference in passed tasks. With the skill: 10 s faster per task, 400 fewer tokens.");
  assert.equal(skillEvalSummary(result(side(2, 4), side(2, 5))).verdict, "The skill helped: the pass rate is 10 points higher.");
  assert.equal(skillEvalSummary(result(side(2, 4), side(2, 4), { delta: null })).verdict, "The two runs cannot be compared.");
  assert.equal(skillEvalSummary(result(side(0, 0), side(0, 0))).verdict, "The task set has no tasks.");
  // Unknown tokens are left out, not shown as zero.
  assert.equal(skillEvalSummary(result(side(1, 2), side(1, 2))).lines[0].text, "1 of 2 tasks passed (50%)");
});

test("--repeat counts runs, and the notes say what to know", () => {
  const sum = skillEvalSummary(result(side(3, 4, 0, null, { errors: 1 }), side(2, 4, 0, null, { errors: 1 }),
    { repeat: 2, complete: false, approvalsDenied: 1 }));
  assert.equal(sum.lines[0].text, "3 of 4 runs passed (75%)");
  assert.equal(sum.verdict, "The skill helped: 1 more run passed.");
  assert.deepEqual(sum.notes, [
    "Stopped early: not every run finished.",
    "2 runs ended in an error or ran out of time.",
    "1 action needed your approval and was refused, since nobody can answer during a test.",
  ]);
});

test("the card shows nothing until main says the skill can be tested", () => {
  assert.equal(skillEvalHTML({ name: "guide", probe: null }, esc), "");
  assert.equal(skillEvalHTML({ name: "guide", probe: { ok: true, available: false, reason: "agent" } }, esc), "");
  assert.equal(skillEvalHTML({ name: "guide", probe: { ok: true, available: false, reason: "tasks" } }, esc), "");
  const ready = skillEvalHTML({ name: "guide", probe: { ok: true, available: true, tasksFile: "/s/guide/tasks.yml" }, runningName: null, outcome: null }, esc);
  assert.match(ready, /data-act="skills:test:guide"[^>]*>Test skill</);
  assert.match(ready, /Runs the tasks in tasks\.yml with and without this skill\./);
  assert.doesNotMatch(ready, /disabled/);
});

test("running, cancelling, another run and the outcomes", () => {
  const probe = { ok: true, available: true, tasksFile: "/s/guide/tasks.yaml" };
  const running = skillEvalHTML({ name: "guide", probe, runningName: "guide", cancelling: false }, esc);
  assert.match(running, /tk-spin/);
  assert.match(running, /data-act="skills:testCancel">Cancel</);
  assert.doesNotMatch(running, /skills:test:guide/);
  assert.match(skillEvalHTML({ name: "guide", probe, runningName: "guide", cancelling: true }, esc), /Stopping the test.*disabled>Cancel/s);
  const other = skillEvalHTML({ name: "guide", probe, runningName: "other" }, esc);
  assert.match(other, /skills:test:guide" disabled/);
  assert.match(other, /Another skill test is running/);
  const done = skillEvalHTML({ name: "guide", probe,
    outcome: { ok: true, savedPath: "/state/skill-evals/guide/r1.json", result: result(side(2, 2), side(1, 2), { approvalsDenied: 2 }) } }, esc);
  assert.match(done, /<b>With the skill:<\/b> 2 of 2 tasks passed \(100%\)/);
  assert.match(done, /The skill helped: 1 more task passed\./);
  assert.match(done, /2 actions needed your approval and were refused/);
  assert.match(done, /Saved to <span class="mono">\/state\/skill-evals\/guide\/r1\.json<\/span>/);
  assert.match(skillEvalHTML({ name: "guide", probe, outcome: { ok: false, cancelled: true } }, esc), /Test stopped\./);
  assert.match(skillEvalHTML({ name: "guide", probe, outcome: { ok: false, error: "no model <set>" } }, esc), /tk-help--err">no model &lt;set&gt;</);
  // No long dashes in what the person reads.
  for (const html of [ready(probe), running, other, done]) assert.doesNotMatch(html, /—/);
  function ready(p) { return skillEvalHTML({ name: "guide", probe: p }, esc); }
});

test("main: probe from #1307's help, task file and argv", () => {
  const help = "Subcommands:\n  show <name>                Print SKILL.md for an installed skill\n"
    + "  eval <name> --tasks <tasks.yaml> [--repeat <n>] [--only with|without] [--max-steps <n>] [--no-approval] [--json]\n"
    + "                             Run each task with the skill and without it, check the answers, and save\n";
  assert.equal(skillEvalSupported(help), true);
  assert.equal(skillEvalSupported("Subcommands:\n  show <name>   Print SKILL.md\n  evaluate is not here\n"), false);
  assert.equal(skillEvalSupported("unknown subcommand: eval\n"), false);
  const dir = join("/skills", "guide");
  const md = join(dir, "SKILL.md");
  assert.equal(skillEvalTasksFile(md, (p) => p === join(dir, "tasks.yml")), join(dir, "tasks.yml"));
  assert.equal(skillEvalTasksFile(md, (p) => p === join(dir, "tasks.json")), join(dir, "tasks.json"));
  assert.equal(skillEvalTasksFile(md, () => true), join(dir, "tasks.yaml"));
  assert.equal(skillEvalTasksFile(md, () => false), null);
  assert.equal(skillEvalTasksFile("", () => true), null);
  // Never --no-approval: approvals stay refused, as #1307 does by default.
  assert.deepEqual(skillEvalArgs("guide", "/s/tasks.yaml"), ["skill", "eval", "guide", "--tasks", "/s/tasks.yaml", "--json"]);
});

// The result document as #1307 writes it (src/skills/eval/eval-result.ts).
const S = (passed, runs, wallMsMean, totalTokens, errors = 0) => ({
  runs, passed, accuracy: runs ? passed / runs : 0, wallMsTotal: wallMsMean * runs, wallMsMean,
  promptTokens: totalTokens, completionTokens: 0, totalTokens, costUsd: 0, errors, skillLoadedRuns: runs,
});
const doc = (over = {}, summary = {}) => ({
  schema: "atomic-agent.skill-eval/1", runId: "2026-11-12T09-30-00-000Z", complete: true,
  skill: { name: "guide", version: "1.0.0", source: "global" },
  tasks: { file: "/s/guide/tasks.yaml", sha256: "abc", count: 2 },
  options: { repeat: 1, variants: ["with", "without"], maxSteps: null, approvalLevel: 2 },
  runs: [{ taskId: "a", variant: "with", approvalsDenied: 1 }, { taskId: "a", variant: "without", approvalsDenied: 0 }],
  summary: {
    with: S(3, 4, 40000, 71600), without: S(2, 4, 45000, 62600, 1),
    delta: { accuracy: 0.25, wallMsMean: -5000, totalTokens: 9000, costUsd: 0 },
    perTask: [{ taskId: "a", with: S(1, 1, 40000, 100), without: null }],
    ...summary,
  },
  ...over,
});

test("main: the --json document is read whole, pretty-printed as the CLI prints it", () => {
  const stderr = "skill eval: guide, 2 task(s) x with/without x 1\n  [1/4] a with #1: pass (reply, 40.0s)\nsaved: /state/skill-evals/guide/2026-11-12T09-30-00-000Z.json\n";
  assert.deepEqual(parseSkillEvalOutput(`${JSON.stringify(doc(), null, 2)}\n`, "guide", stderr), {
    ok: true,
    savedPath: "/state/skill-evals/guide/2026-11-12T09-30-00-000Z.json",
    result: {
      skill: "guide", runId: "2026-11-12T09-30-00-000Z", complete: true, repeat: 1,
      with: { runs: 4, passed: 3, accuracy: 0.75, secondsMean: 40, tokens: 71600, costUsd: 0, errors: 0 },
      without: { runs: 4, passed: 2, accuracy: 0.5, secondsMean: 45, tokens: 62600, costUsd: 0, errors: 1 },
      delta: { accuracy: 0.25, secondsMean: -5, tokens: 9000, costUsd: 0 },
      perTask: [{ taskId: "a", with: { passed: 1, runs: 1 }, without: null }],
      approvalsDenied: 1,
    },
  });
  assert.equal(skillEvalSavedPath("nothing saved\n"), null);
  assert.equal(parseSkillEvalOutput("a notice\n" + JSON.stringify(doc()), "guide").ok, true);
  // Stopped before the plan finished: still printed, and said so.
  assert.equal(parseSkillEvalOutput(JSON.stringify(doc({ complete: false })), "guide").result.complete, false);
  assert.equal(parseSkillEvalOutput(JSON.stringify(doc({ skill: undefined })), "fallback").result.skill, "fallback");
  // Null tokens (the provider reported none) stay null.
  assert.equal(parseSkillEvalOutput(JSON.stringify(doc({}, { with: S(1, 1, 1000, null) })), "g").result.with.tokens, null);
});

test("main: anything else is an error, never a made-up result", () => {
  assert.equal(parseSkillEvalOutput("", "g").ok, false);
  assert.equal(parseSkillEvalOutput("variant   accuracy   mean time\nwith      3/4 75%\n", "g").ok, false);
  assert.equal(parseSkillEvalOutput("{not json", "g").ok, false);
  assert.equal(parseSkillEvalOutput(JSON.stringify(doc({ schema: "something-else/1" })), "g").ok, false);
  assert.equal(parseSkillEvalOutput(JSON.stringify(doc({ summary: undefined })), "g").ok, false);
  // --only with|without leaves one variant null: nothing to compare.
  const one = parseSkillEvalOutput(JSON.stringify(doc({}, { without: null, delta: null })), "g");
  assert.equal(one.ok, false);
  assert.match(one.error, /both with and without/);
  assert.equal(parseSkillEvalOutput(JSON.stringify(doc({}, { with: S(5, 4, 1, 1) })), "g").ok, false);
  assert.equal(parseSkillEvalOutput(JSON.stringify(doc({}, { with: { ...S(1, 4, 1, 1), passed: "1" } })), "g").ok, false);
});

test("wiring: preload, main and the skill card", () => {
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /skillEvalProbe: \(name: string\) => ipcRenderer\.invoke\("cli:skillEvalProbe", name\)/);
  assert.match(preload, /skillEvalRun: \(name: string\) => ipcRenderer\.invoke\("cli:skillEvalRun", name\)/);
  assert.match(preload, /skillEvalCancel: \(\) => ipcRenderer\.invoke\("cli:skillEvalCancel"\)/);
  const ipc = readFileSync(new URL("../main/skill-eval-ipc.ts", import.meta.url), "utf8");
  for (const ch of ["cli:skillEvalProbe", "cli:skillEvalRun", "cli:skillEvalCancel"]) assert.ok(ipc.includes(`ipcMain.handle("${ch}"`), ch);
  assert.match(ipc, /parseSkillEvalOutput\(res\.stdout, name, res\.stderr\)/);
  assert.doesNotMatch(ipc, /--no-approval/);
  assert.match(readFileSync(new URL("../main/main.ts", import.meta.url), "utf8"), /wireSkillEvalIpc\(\{ cwd: \(\) => client\.status\.workingDir \}\)/);
  const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(renderer, /\+ skillEvalHTML\(\{name, probe:SKE\.probeName === name \? SKE\.probe : null/);
  assert.match(renderer, /if \(verb === 'test'\) \{ const name = sel\(\); if \(name\) skeRun\(name\); return; \}/);
  assert.match(renderer, /SKP\.lastError = null; render\(\);\n  skeProbe\(name\);/);
});
