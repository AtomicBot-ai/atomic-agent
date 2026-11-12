import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkillRegistry } from "../skills/skill-registry.js";
import type { SkillEvalTask } from "../skills/eval/index.js";
import { buildSummary, SKILL_EVAL_RESULT_SCHEMA, type SkillEvalResult, type SkillEvalRunRecord } from "../skills/eval/index.js";
import {
  createRuntimeSkillEvalDriver,
  formatSkillEvalSummary,
  parseSkillEvalArgs,
  skillEvalCommand,
  type SkillEvalRuntime,
} from "./skill-eval-command.js";

describe("parseSkillEvalArgs", () => {
  it("reads the skill, the tasks file and every option", () => {
    expect(
      parseSkillEvalArgs(["pdf", "--tasks", "t.yaml", "--repeat", "3", "--only", "without", "--max-steps", "9", "--no-approval", "--json", "--keep-workdir"]),
    ).toEqual({
      skill: "pdf",
      tasksFile: "t.yaml",
      repeat: 3,
      variants: ["without"],
      maxSteps: 9,
      noApproval: true,
      json: true,
      keepWorkdir: true,
    });
  });

  it("defaults to both variants, one attempt", () => {
    expect(parseSkillEvalArgs(["pdf", "--tasks", "t.yaml"])).toMatchObject({ repeat: 1, variants: ["with", "without"], maxSteps: null });
  });

  it.each([
    [["--tasks", "t.yaml"], "missing <skill>"],
    [["pdf"], "missing --tasks"],
    [["pdf", "--tasks"], "--tasks requires a file"],
    [["pdf", "--tasks", "t.yaml", "--repeat", "0"], "--repeat expects a positive integer"],
    [["pdf", "--tasks", "t.yaml", "--only", "both"], "--only expects with or without"],
    [["pdf", "--tasks", "t.yaml", "--bogus"], "unknown flag: --bogus"],
    [["pdf", "xlsx", "--tasks", "t.yaml"], "unexpected argument: xlsx"],
  ])("rejects %j", (args, error) => {
    expect(parseSkillEvalArgs(args)).toEqual({ error });
  });
});

describe("skillEvalCommand", () => {
  let stderr = "";
  beforeEach(() => {
    stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("exits 2 on bad arguments before booting anything", async () => {
    expect(await skillEvalCommand(["pdf"])).toBe(2);
    expect(stderr).toContain("missing --tasks");
    expect(stderr).toContain("usage: atomic-agent skill eval");
  });

  it("exits 2 when the tasks file names another skill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-eval-cli-"));
    try {
      const file = join(dir, "tasks.yaml");
      writeFileSync(file, "skill: xlsx\ntasks:\n  - { id: a, prompt: x, check: { type: regex, pattern: x } }\n");
      expect(await skillEvalCommand(["pdf", "--tasks", file])).toBe(2);
      expect(stderr).toContain('written for skill "xlsx", not "pdf"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createRuntimeSkillEvalDriver", () => {
  let globalDir: string;
  let registry: SkillRegistry;

  beforeEach(async () => {
    globalDir = mkdtempSync(join(tmpdir(), "skill-eval-driver-"));
    for (const name of ["demo", "other"]) {
      mkdirSync(join(globalDir, name));
      writeFileSync(join(globalDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: "Skill ${name}"\nversion: 0.1.0\n---\n\nBody.\n`);
    }
    // "demo" starts disabled in config: the eval must still show it for `with`.
    registry = new SkillRegistry({ globalDir, projectDir: null }, ["demo", "other"]);
    await registry.refresh();
  });
  afterEach(() => rmSync(globalDir, { recursive: true, force: true }));

  function fakeRuntime(events: unknown[], usage = { promptTokens: 50, completionTokens: 5 }) {
    const deleted: string[] = [];
    const refreshSkills = vi.fn(async () => {});
    const runTurn = vi.fn(async (session: { id: string }, _message: string, options?: { eventHook?: (e: never) => void }) => {
      for (const e of events) options?.eventHook?.(e as never);
      return { session: { ...session, lastError: null }, reason: "reply", stepCount: 3, usage, spendUsd: 0.004 };
    });
    const runtime = {
      skillRegistry: registry,
      refreshSkills,
      createSession: vi.fn(() => ({ id: "session-1" })),
      runTurn,
      sessionStore: { delete: (id: string) => deleted.push(id) },
    } as unknown as SkillEvalRuntime;
    return { runtime, deleted, refreshSkills, runTurn };
  }

  const task: SkillEvalTask = { id: "t", prompt: "do it", checks: [], fixturesDir: null, maxSteps: 4, timeoutMs: 1000 };

  it("shows and hides only the evaluated skill, in memory, and rebuilds the catalog", async () => {
    const { runtime, refreshSkills } = fakeRuntime([]);
    const driver = createRuntimeSkillEvalDriver(runtime, "demo", { approvalsDenied: 0 });
    await driver.setVariant("with");
    expect(registry.has("demo")).toBe(true);
    expect(registry.has("other")).toBe(false);
    await driver.setVariant("without");
    expect(registry.has("demo")).toBe(false);
    expect(registry.getDisabledNames()).toEqual(["demo", "other"]);
    expect(refreshSkills).toHaveBeenCalledTimes(2);
  });

  it("collects the final reply, whether the skill was loaded, usage, and deletes the session", async () => {
    const events = [
      { type: "llm_event", event: { type: "tool_call_parsed", call: { tool: "skill.view", args: { name: "demo" } }, batchIndex: 0, batchSize: 1 } },
      { type: "llm_event", event: { type: "assistant_reply", text: "working on it", progressNote: true } },
      { type: "llm_event", event: { type: "assistant_reply", text: "42" } },
    ];
    const { runtime, deleted, runTurn } = fakeRuntime(events);
    const counters = { approvalsDenied: 0 };
    const driver = createRuntimeSkillEvalDriver(runtime, "demo", counters);
    await driver.setVariant("with");
    const out = await driver.runTask({ task, variant: "with", workingDir: "/tmp/x", signal: new AbortController().signal });
    expect(out).toEqual({
      reply: "42",
      end: "reply",
      error: null,
      steps: 3,
      promptTokens: 50,
      completionTokens: 5,
      costUsd: 0.004,
      approvalsDenied: 0,
      skillLoaded: true,
    });
    expect(runTurn.mock.calls[0]![2]).toMatchObject({ maxSteps: 4, origin: "cli" });
    expect(deleted).toEqual(["session-1"]);
  });

  it("does not count another skill's skill.view as loading this one", async () => {
    const events = [{ type: "llm_event", event: { type: "tool_call_parsed", call: { tool: "skill.view", args: { name: "other" } }, batchIndex: 0, batchSize: 1 } }];
    const { runtime } = fakeRuntime(events);
    const driver = createRuntimeSkillEvalDriver(runtime, "demo", { approvalsDenied: 0 });
    await driver.setVariant("without");
    const out = await driver.runTask({ task, variant: "without", workingDir: "/tmp/x", signal: new AbortController().signal });
    expect(out.skillLoaded).toBe(false);
    expect(out.reply).toBeNull();
  });
});

describe("formatSkillEvalSummary", () => {
  function rec(variant: "with" | "without", passed: boolean, wallMs: number): SkillEvalRunRecord {
    return {
      taskId: "t", variant, attempt: 1, passed, checks: [], end: "reply", reply: "x", error: null, wallMs,
      steps: 1, promptTokens: 100, completionTokens: 0, costUsd: 0, approvalsDenied: 0, skillLoaded: variant === "with",
    };
  }

  it("prints one row per variant and the difference", () => {
    const runs = [rec("with", true, 2000), rec("without", false, 4000)];
    const result: SkillEvalResult = {
      schema: SKILL_EVAL_RESULT_SCHEMA, runId: "r", complete: true,
      skill: { name: "demo", version: "1", source: "global" },
      tasks: { file: "/t.yaml", sha256: "", count: 1 },
      startedAt: "", finishedAt: "", agentVersion: "0", model: { provider: "local-llama", model: "m" },
      options: { repeat: 1, variants: ["with", "without"], maxSteps: null, approvalLevel: 2 },
      runs, summary: buildSummary(runs, ["t"]),
    };
    const text = formatSkillEvalSummary(result);
    expect(text).toContain("skill eval: demo (1 tasks, model m)");
    expect(text).toMatch(/^with\s+1\/1 100%\s+2\.0s\s+100\s+\$0\.0000$/m);
    expect(text).toMatch(/^without\s+0\/1 0%\s+4\.0s/m);
    expect(text).toContain("difference: accuracy +100 pts, time -2s, tokens 0, cost +$0.0000");
  });
});
