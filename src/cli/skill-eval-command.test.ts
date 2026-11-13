import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryReadOnlyToolFilter } from "../agent/tool-resource-class.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import type { AtomicAgentConfig } from "../config/index.js";
import type { SkillEvalJudge, SkillEvalJudgeConfig, SkillEvalTask } from "../skills/eval/index.js";
import { buildSummary, SKILL_EVAL_RESULT_SCHEMA, type SkillEvalResult, type SkillEvalRunRecord } from "../skills/eval/index.js";
import {
  buildSkillEvalJudge,
  createRuntimeSkillEvalDriver,
  formatSkillEvalSummary,
  parseSkillEvalArgs,
  resolveSkillEvalJudge,
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
      all: false,
      checkTasks: false,
      repeat: 3,
      variants: ["without"],
      maxSteps: 9,
      noApproval: true,
      json: true,
      keepWorkdir: true,
      judgeUrl: null,
      judgeModel: null,
    });
  });

  it("reads the judge flags", () => {
    expect(parseSkillEvalArgs(["pdf", "--tasks", "t.yaml", "--judge-url", "http://127.0.0.1:8080", "--judge-model", "qwen"])).toMatchObject({
      judgeUrl: "http://127.0.0.1:8080",
      judgeModel: "qwen",
    });
    expect(parseSkillEvalArgs(["pdf", "--tasks", "t.yaml", "--judge-url"])).toEqual({ error: "--judge-url requires a value" });
  });

  it("lets the tasks file be found next to the skill, and reads --all and --check-tasks", () => {
    expect(parseSkillEvalArgs(["pdf"])).toMatchObject({ skill: "pdf", tasksFile: null, all: false });
    expect(parseSkillEvalArgs(["--all", "--check-tasks"])).toMatchObject({ skill: null, all: true, checkTasks: true });
  });

  it("defaults to both variants, one attempt", () => {
    expect(parseSkillEvalArgs(["pdf", "--tasks", "t.yaml"])).toMatchObject({ repeat: 1, variants: ["with", "without"], maxSteps: null });
  });

  it.each([
    [["--tasks", "t.yaml"], "missing <skill> (or --all)"],
    [["pdf", "--all"], "--all evaluates every skill with a tasks file; leave out <skill>"],
    [["--all", "--tasks", "t.yaml"], "--all finds each skill's tasks file; leave out --tasks"],
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
    expect(await skillEvalCommand(["--tasks", "t.yaml"])).toBe(2);
    expect(stderr).toContain("missing <skill>");
    expect(stderr).toContain("usage: atomic-agent skill eval");
  });

  it("refuses an installed (hub) skill's own tasks file without --tasks, and --all skips it", async () => {
    const globalDir = join(process.env.ATOMIC_AGENT_STATE_DIR!, "skills", "hub-thing");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "SKILL.md"), "---\nname: hub-thing\ndescription: x\nversion: 1.0.0\n---\n");
    writeFileSync(join(globalDir, "tasks.yaml"), "tasks:\n  - { id: a, prompt: x, check: { type: command, run: 'touch pwned' } }\n");
    try {
      expect(await skillEvalCommand(["hub-thing"])).toBe(2);
      expect(stderr).toContain("hub-thing is an installed skill");
      expect(stderr).toContain(`pass --tasks ${join(globalDir, "tasks.yaml")}`);
      stderr = "";
      expect(await skillEvalCommand(["--all", "--check-tasks"])).toBe(0);
      expect(stderr).toContain("skipped hub-thing: an installed skill's tasks run only with --tasks");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("exits 2 when a skill has no tasks file and none is given", async () => {
    expect(await skillEvalCommand(["no-such-skill-here"])).toBe(2);
    expect(stderr).toContain("no tasks file for no-such-skill-here");
  });

  it("--check-tasks prints where each starter's tasks file is and runs nothing", async () => {
    let stdout = "";
    vi.mocked(process.stdout.write).mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    expect(await skillEvalCommand(["--all", "--check-tasks"])).toBe(0);
    expect(stdout).toMatch(/^plain-writing\t\d+ tasks\t.*plain-writing[\\/]evals[\\/]tasks\.yaml$/m);
  });

  it("exits 2 before booting when judge checks have no usable judge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-eval-cli-"));
    const names = ["ATOMIC_AGENT_JUDGE_URL", "ATOMIC_AGENT_JUDGE_MODEL", "OPENROUTER_API_KEY", "ATOMIC_AGENT_JUDGE_API_KEY"] as const;
    const saved = names.map((name) => [name, process.env[name]] as const);
    for (const name of names) delete process.env[name];
    try {
      const file = join(dir, "tasks.yaml");
      writeFileSync(file, "tasks:\n  - { id: a, prompt: x, check: { type: judge, rubric: r } }\n");
      // No judge env, no skills.eval.judgeProvider, the local model active
      // (the test state dir has no config): there is no judge to use.
      expect(await skillEvalCommand(["pdf", "--tasks", file])).toBe(2);
      expect(stderr).toContain("has judge checks, but there is no judge: the active model is local");
      stderr = "";
      expect(await skillEvalCommand(["pdf", "--tasks", file, "--judge-url", "https://judge.example/v1", "--judge-model", "m"])).toBe(2);
      expect(stderr).toContain("the judge at https://judge.example/v1 needs an API key");
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("runs every turn with memory read-only, so a note written in one variant never reaches the other", async () => {
    // A stand-in for the runtime: memory is one shared notes list, the
    // model stores a note whenever memory.notes.store is on offer, and
    // a turn's reply is what it recalled. The turn service hides the
    // write tools for a memoryReadOnly turn (memoryReadOnlyToolFilter).
    const notes: string[] = [];
    const runTurn = vi.fn(
      async (session: { id: string }, message: string, options?: { memoryReadOnly?: boolean; toolFilter?: (n: string) => boolean; eventHook?: (e: never) => void }) => {
        const filter = options?.memoryReadOnly ? memoryReadOnlyToolFilter(options.toolFilter) : (options?.toolFilter ?? (() => true));
        const recalled = filter("memory.notes.recall") ? notes.join(",") : "";
        if (filter("memory.notes.store")) notes.push(`answer for ${message}`);
        options?.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: recalled || "nothing" } } as never);
        return { session: { ...session, lastError: null }, reason: "reply", stepCount: 1, usage: null, spendUsd: 0 };
      },
    );
    const runtime = {
      skillRegistry: registry,
      refreshSkills: vi.fn(async () => {}),
      createSession: vi.fn(() => ({ id: "session-1" })),
      runTurn,
      sessionStore: { delete: () => {} },
    } as unknown as SkillEvalRuntime;
    const driver = createRuntimeSkillEvalDriver(runtime, "demo", { approvalsDenied: 0 });
    await driver.setVariant("with");
    await driver.runTask({ task, variant: "with", workingDir: "/tmp/x", signal: new AbortController().signal });
    await driver.setVariant("without");
    const b = await driver.runTask({ task, variant: "without", workingDir: "/tmp/x", signal: new AbortController().signal });
    expect(runTurn.mock.calls.every((call) => call[2]?.memoryReadOnly === true)).toBe(true);
    expect(notes).toEqual([]);
    expect(b.reply).toBe("nothing");
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

describe("judge from the person's providers", () => {
  const config = {
    llm: {
      activeTextProvider: "local-llama",
      activeEmbeddingProvider: "local-llama-embed",
      providers: [
        { id: "local-llama", kind: "llama-server" },
        { id: "cloud-b", kind: "openrouter", model: "b-model" },
      ],
      toolTransport: "auto",
    },
    skills: { eval: { judgeProvider: "cloud-b" } },
  } as unknown as AtomicAgentConfig;

  it("skills.eval.judgeProvider picks that provider, and the judge calls it", async () => {
    const picked = resolveSkillEvalJudge({ judgeUrl: null, judgeModel: null }, config, {});
    expect(picked).toMatchObject({ kind: "provider", providerId: "cloud-b", source: "judgeProvider" });
    const complete = vi.fn(async () => ({ content: '{"score":5,"reason":"ok"}', usage: { promptTokens: 9, completionTokens: 1, totalTokens: 10, costUsd: 0.01 }, modelId: "b-model" }));
    const getProvider = vi.fn(() => ({ id: "cloud-b", chatModelId: "b-model", complete }));
    const judge = buildSkillEvalJudge(picked as SkillEvalJudgeConfig, { providerRegistry: { getProvider } } as never, config);
    expect("error" in judge).toBe(false);
    const verdict = await (judge as SkillEvalJudge).score({ prompt: "p", reply: "r", rubric: "q", reference: null });
    expect(getProvider).toHaveBeenCalledWith("cloud-b");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(verdict.score).toBe(5);
  });

  it("a judge provider the runtime did not load is an error", () => {
    const built = buildSkillEvalJudge(
      { kind: "provider", providerId: "cloud-b", model: null, source: "judgeProvider", timeoutMs: 1000 },
      { providerRegistry: { getProvider: () => undefined } } as never,
      config,
    );
    expect(built).toEqual({ error: expect.stringContaining('"cloud-b" did not load') });
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
      startedAt: "", finishedAt: "", agentVersion: "0", model: { provider: "local-llama", model: "m" }, judge: null, judgeUsage: null,
      options: { repeat: 1, variants: ["with", "without"], maxSteps: null, approvalLevel: 2 },
      runs, summary: buildSummary(runs, ["t"]),
    };
    const text = formatSkillEvalSummary(result);
    expect(text).toContain("skill eval: demo (1 tasks, model m)");
    expect(text).toMatch(/^with\s+1\/1 100%\s+2\.0s\s+100\s+\$0\.0000$/m);
    expect(text).toMatch(/^without\s+0\/1 0%\s+4\.0s/m);
    expect(text).toContain("difference: accuracy +100 pts, time -2s, tokens 0, cost +$0.0000");
    expect(text).not.toContain("judge:");
    const judged = formatSkillEvalSummary({
      ...result,
      judge: { provider: "cloud-b", model: "b-model", url: null },
      judgeUsage: { calls: 2, promptTokens: 600, completionTokens: 40, totalTokens: 640, costUsd: 0.0031 },
    });
    expect(judged).toContain("judge: 640 tokens, $0.0031 (2 calls, cloud-b b-model)");
  });
});
