import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planRuns, runSkillEval, type SkillEvalDriver, type SkillEvalDriverRun } from "./run-skill-eval.js";
import { parseTaskSet, type SkillEvalTask, type SkillEvalTaskSet } from "./task-set.js";
import type { SkillEvalVariant } from "./eval-result.js";

function run(overrides: Partial<SkillEvalDriverRun> = {}): SkillEvalDriverRun {
  return {
    reply: "ok",
    end: "reply",
    error: null,
    steps: 2,
    promptTokens: 100,
    completionTokens: 10,
    costUsd: 0.01,
    approvalsDenied: 0,
    skillLoaded: false,
    ...overrides,
  };
}

/** A driver whose reply depends on the variant, recording what it was asked. */
function fakeDriver(
  reply: (variant: SkillEvalVariant, task: SkillEvalTask, workingDir: string) => Partial<SkillEvalDriverRun>,
): SkillEvalDriver & { calls: string[] } {
  const calls: string[] = [];
  let variant: SkillEvalVariant | null = null;
  return {
    calls,
    async setVariant(v) {
      calls.push(`set:${v}`);
      variant = v;
    },
    async runTask({ task, variant: asked, workingDir }) {
      if (asked !== variant) throw new Error("runTask before setVariant");
      calls.push(`run:${task.id}:${asked}`);
      return run(reply(asked, task, workingDir));
    },
  };
}

const baseOptions = {
  skill: { name: "demo", version: "1.0.0", source: "global" },
  repeat: 1,
  variants: ["with", "without"] as SkillEvalVariant[],
  maxSteps: null,
  approvalLevel: 2,
  agentVersion: "0.0.0-test",
  model: { provider: "local-llama", model: "test-model" },
};

describe("planRuns", () => {
  const tasks = [{ id: "a" }, { id: "b" }] as SkillEvalTask[];

  it("runs both variants of a task back to back and flips who goes first", () => {
    const plan = planRuns(tasks, 2, ["with", "without"]).map((p) => `${p.task.id}:${p.variant}:${p.attempt}`);
    expect(plan).toEqual([
      "a:with:1", "a:without:1",
      "b:without:1", "b:with:1",
      "a:without:2", "a:with:2",
      "b:with:2", "b:without:2",
    ]);
  });

  it("keeps only the variants asked for", () => {
    expect(planRuns(tasks, 1, ["without"]).map((p) => p.variant)).toEqual(["without", "without"]);
  });
});

describe("runSkillEval", () => {
  let dir: string;
  let workRoot: string;
  let taskSet: SkillEvalTaskSet;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-eval-run-"));
    workRoot = join(dir, "work");
    mkdirSync(workRoot);
    mkdirSync(join(dir, "fx"));
    writeFileSync(join(dir, "fx", "input.txt"), "data");
    taskSet = parseTaskSet(
      [
        "tasks:",
        "  - { id: t1, prompt: one, fixtures: fx, check: { type: exact, expected: right } }",
        "  - { id: t2, prompt: two, check: { type: regex, pattern: right } }",
      ].join("\n"),
      join(dir, "tasks.yaml"),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("scores both variants and summarizes the difference", async () => {
    const driver = fakeDriver((variant) =>
      variant === "with" ? { reply: "right", promptTokens: 200, costUsd: 0.02, skillLoaded: true } : { reply: "wrong" },
    );
    let t = 0;
    const result = await runSkillEval({
      ...baseOptions,
      taskSet,
      driver,
      workRoot,
      now: () => new Date("2026-11-12T09:30:00.000Z"),
      clock: () => (t += 1000),
    });
    expect(result.schema).toBe("atomic-agent.skill-eval/1");
    expect(result.runId).toBe("2026-11-12T09-30-00-000Z");
    expect(result.complete).toBe(true);
    expect(result.runs).toHaveLength(4);
    expect(result.summary.with).toMatchObject({ runs: 2, passed: 2, accuracy: 1, totalTokens: 420, skillLoadedRuns: 2 });
    expect(result.summary.without).toMatchObject({ runs: 2, passed: 0, accuracy: 0, totalTokens: 220 });
    expect(result.summary.delta).toMatchObject({ accuracy: 1, totalTokens: 200 });
    expect(result.summary.delta!.costUsd).toBeCloseTo(0.02);
    expect(result.summary.perTask.map((r) => [r.taskId, r.with?.passed, r.without?.passed])).toEqual([
      ["t1", 1, 0],
      ["t2", 1, 0],
    ]);
    expect(result.runs.every((r) => r.wallMs === 1000)).toBe(true);
    // setVariant only when the variant changes: t1 with,without; t2 without,with.
    expect(driver.calls).toEqual(["set:with", "run:t1:with", "set:without", "run:t1:without", "run:t2:without", "set:with", "run:t2:with"]);
  });

  it("gives each run a clean working folder with its own fixtures", async () => {
    const seen: string[][] = [];
    const driver = fakeDriver((_v, _task, workingDir) => {
      seen.push(readdirSync(workingDir).sort());
      writeFileSync(join(workingDir, "left-behind.txt"), "x");
      return { reply: "right" };
    });
    await runSkillEval({ ...baseOptions, taskSet, driver, workRoot });
    expect(seen).toEqual([["input.txt"], ["input.txt"], [], []]);
    expect(existsSync(workRoot)).toBe(true);
  });

  it("a timed-out or crashed run fails without running checks", async () => {
    const driver: SkillEvalDriver = {
      async setVariant() {},
      async runTask({ variant, signal }) {
        if (variant === "with") throw new Error("boom");
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return run({ reply: "right", end: "cancelled" });
      },
    };
    const quick = { ...taskSet, tasks: taskSet.tasks.map((t) => ({ ...t, timeoutMs: 50 })) };
    const result = await runSkillEval({ ...baseOptions, taskSet: quick, driver, workRoot });
    const withRun = result.runs.find((r) => r.variant === "with")!;
    const withoutRun = result.runs.find((r) => r.variant === "without")!;
    expect(withRun).toMatchObject({ end: "error", error: "boom", passed: false, checks: [], promptTokens: null });
    expect(withoutRun).toMatchObject({ end: "timeout", passed: false, checks: [] });
    expect(result.summary.with!.errors).toBe(2);
  });

  it("passes --max-steps to tasks that set none", async () => {
    const steps: Array<number | null> = [];
    const driver = fakeDriver((_v, task) => {
      steps.push(task.maxSteps);
      return {};
    });
    await runSkillEval({ ...baseOptions, variants: ["with"], maxSteps: 7, taskSet, driver, workRoot });
    expect(steps).toEqual([7, 7]);
  });

  it("stops between runs when aborted and marks the result incomplete", async () => {
    const controller = new AbortController();
    const driver = fakeDriver(() => {
      controller.abort();
      return { reply: "right" };
    });
    const result = await runSkillEval({ ...baseOptions, taskSet, driver, workRoot, signal: controller.signal });
    expect(result.complete).toBe(false);
    expect(result.runs).toHaveLength(1);
  });

  it("reports null tokens and cost when no run reported any", async () => {
    const driver = fakeDriver(() => ({ promptTokens: null, completionTokens: null, costUsd: null }));
    const result = await runSkillEval({ ...baseOptions, taskSet, driver, workRoot });
    expect(result.summary.with).toMatchObject({ totalTokens: null, costUsd: null });
    expect(result.summary.delta).toMatchObject({ totalTokens: null, costUsd: null });
  });

  it("grades judge checks with the given judge and averages the scores per variant", async () => {
    const judged = parseTaskSet(
      "tasks:\n  - { id: j, prompt: explain, check: { type: judge, rubric: clear, minScore: 3 } }\n",
      join(dir, "tasks.yaml"),
    );
    const prompts: string[] = [];
    // A judge already used by an earlier eval (`--all`): only this eval's calls count.
    let calls = 3;
    const judge = {
      model: "judge-model",
      baseUrl: null,
      providerId: "cloud-b",
      usage: () => ({ calls, promptTokens: calls * 100, completionTokens: calls * 10, totalTokens: calls * 110, costUsd: calls * 0.001 }),
      async score(input: { prompt: string; reply: string }) {
        prompts.push(input.prompt);
        calls += 1;
        return { score: input.reply === "good" ? 5 : 2, reason: "", parseFallback: false };
      },
    };
    const driver = fakeDriver((variant) => ({ reply: variant === "with" ? "good" : "meh" }));
    const result = await runSkillEval({ ...baseOptions, repeat: 2, taskSet: judged, driver, workRoot, judge });
    expect(prompts).toEqual(["explain", "explain", "explain", "explain"]);
    expect(result.judge).toEqual({ provider: "cloud-b", model: "judge-model", url: null });
    expect(result.judgeUsage).toEqual({ calls: 4, promptTokens: 400, completionTokens: 40, totalTokens: 440, costUsd: expect.closeTo(0.004, 10) });
    expect(result.summary.with).toMatchObject({ passed: 2, judgeScoreMean: 5 });
    expect(result.summary.without).toMatchObject({ passed: 0, judgeScoreMean: 2 });
    expect(result.summary.delta!.judgeScoreMean).toBe(3);
  });

  it("records no judge and no judge score when no task has a judge check", async () => {
    const result = await runSkillEval({ ...baseOptions, taskSet, driver: fakeDriver(() => ({})), workRoot });
    expect(result.judge).toBeNull();
    expect(result.judgeUsage).toBeNull();
    expect(result.summary.with!.judgeScoreMean).toBeNull();
    expect(result.summary.delta!.judgeScoreMean).toBeNull();
  });
});
