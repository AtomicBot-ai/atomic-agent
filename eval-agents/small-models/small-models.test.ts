import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { buildAgentConfig, oneLine } from "./lib/agent.mjs";
import { foldTrace, usedChunkedAccess } from "./lib/trace.mjs";
import { makeRng } from "./lib/util.mjs";
import { buildPlan } from "./run.mjs";
import { dedupe, gate, parseJsonl, renderMarkdown } from "./summary.mjs";
import { t4Expected, t4Files } from "./tasks/core.mjs";
import { checkHtml, makeBigModule, makeSearchProject, onlyFunctionChanged } from "./tasks/hard.mjs";
import { TASKS as RAW_TASKS, getTask as rawGetTask, selectTasks } from "./tasks/index.mjs";
import { longSessionParts, longSessionTurns, makeNeedleLog, makeNotes } from "./tasks/stress.mjs";

// The task modules are plain .mjs (the runner needs no build); give them a shape here.
interface Verdict {
  pass: boolean;
  reason: string;
  details?: unknown;
}
interface Task {
  id: string;
  set: string;
  timeoutSec: number;
  maxSteps: number;
  turns(ctx: unknown): string[];
  fixture(dir: string, ctx: unknown): unknown;
  check(dir: string, meta: unknown, ctx: unknown): Verdict;
  solve(dir: string, meta: unknown, ctx: unknown): void;
}
const TASKS = RAW_TASKS as unknown as Task[];
const getTask = (id: string) => rawGetTask(id) as unknown as Task;

const roots: string[] = [];
function freshDir(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "small-models-test-"));
  roots.push(root);
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// A trace that satisfies the process checks (needles want a search/ranged read).
const goodTrace = {
  found: true,
  toolCalls: [{ tool: "os.fs.grep", status: "ok", args: { pattern: "AUDIT", path: "data/events.log" } }],
  compactions: 1,
  compactionFailures: 0,
};

describe("every task: untouched fixture fails, reference solution passes", () => {
  for (const task of TASKS) {
    const windows = task.id === "l1" ? [32768, 65536] : [32768];
    for (const window of windows) {
      it(`${task.id} @ ${window}`, () => {
        const ctx = { window, trace: goodTrace, run: { turnsSent: 99, replies: 99, totalTurns: 1 } };
        const a = freshDir("untouched");
        const metaA = task.fixture(a, ctx);
        expect(task.check(a, metaA, ctx).pass).toBe(false);

        const b = freshDir("solved");
        const metaB = task.fixture(b, ctx);
        task.solve(b, metaB, ctx);
        const verdict = task.check(b, metaB, ctx);
        expect(verdict.reason).toBe("");
        expect(verdict.pass).toBe(true);
      });
    }
  }

  it("prompts are non-empty and every task has a timeout and a step cap", () => {
    for (const t of TASKS) {
      expect(t.turns({ window: 32768 }).every((p) => p.trim().length > 20)).toBe(true);
      expect(t.timeoutSec).toBeGreaterThan(0);
      expect(t.maxSteps).toBeGreaterThan(0);
    }
  });

  it("fixtures are deterministic (same bytes twice)", () => {
    expect(makeBigModule()).toBe(makeBigModule());
    expect(makeSearchProject().answer).toBe(makeSearchProject().answer);
    expect(makeNeedleLog(32_000).text).toBe(makeNeedleLog(32_000).text);
    expect(makeRng("x").next()).toBe(makeRng("x").next());
  });
});

describe("t4 / t5 (ported from the 20.10 stand)", () => {
  it("t4 keeps the original answers", () => {
    expect(t4Expected(t4Files())).toEqual({ errors: "43", top: "connection reset by peer" });
  });

  it("t5 ignores __pycache__/*.pyc (the GNU grep false count)", () => {
    const t5 = getTask("t5");
    const d = freshDir("t5");
    const meta = t5.fixture(d, { window: 32768 });
    t5.solve(d, meta, {});
    mkdirSync(join(d, "app", "__pycache__"));
    writeFileSync(join(d, "app", "__pycache__", "users.cpython-312.pyc"), "\0get_user_name fetch_username\0");
    expect(t5.check(d, meta, {})).toEqual({ pass: true, reason: "" });
  });

  it("t5 still fails when a .py file keeps the old name", () => {
    const t5 = getTask("t5");
    const d = freshDir("t5b");
    const meta = t5.fixture(d, { window: 32768 });
    t5.solve(d, meta, {});
    writeFileSync(join(d, "app", "report.py"), readFileSync(join(d, "app", "report.py"), "utf8").replace("fetch_username(", "get_user_name("));
    expect(t5.check(d, meta, {}).pass).toBe(false);
  });
});

describe("h2 long-file edit guard", () => {
  const original = makeBigModule();
  const fixed = original.replace("    return total // 60\n", "    return total\n");

  it("the generated module is over 2000 lines and the bug sits past line 2000", () => {
    const lines = original.split("\n");
    expect(lines.length).toBeGreaterThan(2000);
    expect(lines.findIndex((l: string) => l.startsWith("def parse_duration("))).toBeGreaterThan(2000);
  });

  it("accepts an edit confined to parse_duration", () => {
    expect(onlyFunctionChanged(original, fixed, "parse_duration")).toBeNull();
  });

  it("rejects a truncated rewrite", () => {
    const cut = fixed.split("\n").slice(0, 2300).join("\n");
    expect(onlyFunctionChanged(original, cut, "parse_duration")).toMatch(/lost after/);
  });

  it("rejects touching the decoy parse_duration_ms", () => {
    const decoy = fixed.replace("return total * 1000", "return total*1000");
    expect(onlyFunctionChanged(original, decoy, "parse_duration")).toMatch(/outside parse_duration/);
  });
});

describe("h5 HTML checker", () => {
  const items = ["a", "b"];
  const good = "<html>\n<head>\n<title>T</title>\n</head>\n<body>\n<h1>T</h1>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n</body>\n</html>\n";

  it("passes real newlines", () => {
    expect(checkHtml(good, items, "T").pass).toBe(true);
  });

  it('fails literal "\\n" sequences (Nemotron, 21.10)', () => {
    expect(checkHtml(good.replaceAll("\n", "\\n"), items, "T").reason).toMatch(/literal/);
  });

  it("fails scripts and wrong items", () => {
    expect(checkHtml(good.replace("</body>", "<script>x()</script>\n</body>"), items, "T").pass).toBe(false);
    expect(checkHtml(good, ["a", "c"], "T").pass).toBe(false);
  });
});

describe("needles and long session", () => {
  it("needle log reaches the token target and has exactly one AUDIT line", () => {
    const { text, count } = makeNeedleLog(64_000);
    expect(text.length).toBeGreaterThanOrEqual(64_000 * 3.5);
    expect(text.match(/AUDIT/g)?.length).toBe(1);
    expect(text.match(/code=E42 /g)?.length).toBe(count);
  });

  it("needle check fails without evidence of chunked access", () => {
    const t = getTask("n32k");
    const d = freshDir("n32k");
    const meta = t.fixture(d, { window: 32768 });
    t.solve(d, meta, {});
    const noSearch = { found: true, toolCalls: [{ tool: "os.fs.read", status: "ok", args: { path: "data/events.log" } }] };
    expect(t.check(d, meta, { trace: noSearch }).reason).toMatch(/no search or ranged read/);
    const ranged = { found: true, toolCalls: [{ tool: "os.fs.read", status: "ok", args: { path: "data/events.log", offset: 1, limit: 400 } }] };
    expect(t.check(d, meta, { trace: ranged }).pass).toBe(true);
  });

  it("long session reads ~1.5x the window and ends with a write turn", () => {
    expect(longSessionParts(32768) * 3500).toBeGreaterThan(32768 * 1.4);
    expect(longSessionParts(65536) * 3500).toBeGreaterThan(65536 * 1.4);
    const turns = longSessionTurns(5);
    expect(turns).toHaveLength(4);
    expect(turns[turns.length - 1]).toMatch(/codes\.txt/);
    expect(makeNotes(3).codes).toHaveLength(3);
  });

  it("long session fails when the agent stopped early or compaction never succeeded", () => {
    const t = getTask("l1");
    const d = freshDir("l1");
    const meta = t.fixture(d, { window: 32768 });
    t.solve(d, meta, {});
    expect(t.check(d, meta, { run: { turnsSent: 2, totalTurns: 9 } }).reason).toMatch(/stopped after turn 2/);
    expect(t.check(d, meta, { trace: { found: true, compactions: 0, compactionFailures: 2 } }).reason).toMatch(/compaction failed/);
  });
});

describe("trace folding", () => {
  it("sums tokens, counts compactions and tool errors, skips junk lines", () => {
    const ndjson = [
      JSON.stringify({ type: "step_started" }),
      JSON.stringify({ type: "prompt_captured", tokens: { total: 1000 } }),
      JSON.stringify({ type: "prompt_captured", tokens: { total: 3000 } }),
      JSON.stringify({ type: "llm_completion", timing: { predictedTokens: 50 } }),
      JSON.stringify({ type: "tool_invocation", tool: "os.shell.run", status: "error", args: { cmd: "grep -c E42 data/events.log" } }),
      JSON.stringify({ type: "compaction_completed" }),
      "not json",
    ].join("\n");
    const m = foldTrace(ndjson);
    expect(m).toMatchObject({ found: true, steps: 1, promptTokens: 4000, maxPromptTokens: 3000, predictedTokens: 50, toolErrors: 1, compactions: 1 });
    expect(usedChunkedAccess(m.toolCalls)).toBe(true);
  });
});

describe("agent wiring", () => {
  it("seeds an external-mode config with analytics off and approvals off", () => {
    const c = buildAgentConfig({ serverUrl: "http://127.0.0.1:18190/v1", thinking: "off", maxSteps: 25 });
    expect(c.localModels).toEqual({ mode: "external", url: "http://127.0.0.1:18190", thinking: "off" });
    expect(c.analytics.enabled).toBe(false);
    expect(c.agent).toEqual({ approvalLevel: 5, maxSteps: 25 });
  });

  it("collapses a multi-line prompt into one CLI turn", () => {
    expect(oneLine("a\n  b\r\nc")).toBe("a b c");
  });
});

describe("plan", () => {
  const matrix = JSON.parse(readFileSync(fileURLToPath(new URL("./matrix.json", import.meta.url)), "utf8"));

  it("release profile = 3 models x 2 windows, thinking off, all tasks, 3 repeats", () => {
    const plan = buildPlan({ profile: "release" }, matrix);
    expect(plan.cells).toHaveLength(6);
    expect(plan.runs).toBe(6 * 1 * TASKS.length * 3);
    expect(plan.cells[0]?.server.args).toContain("--jinja");
    expect(plan.cells[0]?.server.args).toContain("32768");
  });

  it("--server-url needs exactly one model and one window", () => {
    expect(() => buildPlan({ "server-url": "http://x", profile: "release" }, matrix)).toThrow(/one model at one window/);
    expect(buildPlan({ "server-url": "http://x", models: "qwen3.5-4b", windows: "32768", tasks: "core" }, matrix).cells).toHaveLength(1);
  });

  it("task selection by set and id", () => {
    expect(selectTasks("core").every((t: { set: string }) => t.set === "core")).toBe(true);
    expect(selectTasks("t1,n1m").map((t: { id: string }) => t.id)).toEqual(["t1", "n1m"]);
    expect(() => selectTasks("nope")).toThrow(/unknown task/);
  });
});

describe("summary and gate", () => {
  const row = (o: Record<string, unknown>) => ({
    model: "qwen3.5-4b", size: "4b", window: 32768, thinking: "off", set: "core", task: "t1", repeat: 1,
    pass: true, reason: "", seconds: 10, promptTokens: 100, predictedTokens: 10, steps: 3, compactions: 0, ...o,
  });
  const thresholds = { gatedSet: "core", minRepeats: 3, minPassRate: { "4b": 0.8 }, requireCells: [] };

  it("last row per run wins", () => {
    expect(dedupe([row({ pass: false }), row({ pass: true })])).toHaveLength(1);
    expect(dedupe([row({ pass: false }), row({ pass: true })])[0]?.pass).toBe(true);
  });

  it("parses JSONL and skips junk", () => {
    expect(parseJsonl(`${JSON.stringify(row({}))}\nnope\n\n`)).toHaveLength(1);
  });

  it("renders a per-task table with rate and median time", () => {
    const md = renderMarkdown([row({ repeat: 1 }), row({ repeat: 2, pass: false, reason: "answer.txt missing", seconds: 30 })]);
    expect(md).toContain("| qwen3.5-4b | 32768 | off | t1 | 1/2 | 50% | 20 |");
    expect(md).toContain("answer.txt missing (×1)");
  });

  it("passes at the threshold, fails below it, reports thin data as missing", () => {
    const five = (fails: number) =>
      ["t1", "t2", "t3", "t4", "t5"].flatMap((task, i) => [1, 2, 3].map((r) => row({ task, repeat: r, pass: !(i < fails && r === 1) })));
    expect(gate(five(3), thresholds).exitCode).toBe(0); // 12/15 = 80%
    expect(gate(five(4), thresholds).exitCode).toBe(1); // 11/15
    expect(gate([row({})], thresholds).exitCode).toBe(3); // 1 run < 3 repeats
  });

  it("a required cell with no results blocks the gate", () => {
    const r = gate([], { ...thresholds, requireCells: [{ size: "4b", window: 65536, thinking: "off" }] });
    expect(r.exitCode).toBe(3);
    expect(r.cells[0]?.why).toMatch(/no results/);
  });

  it("stress rows are not gated", () => {
    const rows = [1, 2, 3].map((r) => row({ repeat: r }));
    const stressFails = [1, 2, 3].map((r) => row({ task: "n1m", set: "stress", repeat: r, pass: false }));
    expect(gate([...rows, ...stressFails], thresholds).exitCode).toBe(0);
  });
});
