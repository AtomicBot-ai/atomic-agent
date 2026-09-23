import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type {
  LessonLifecycleHook,
  MemoryContextProvider,
  RunTurnOptions,
} from "./agent-loop.js";
import type { LlmStreamParams } from "./step-executor.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { AgentLoopEvent } from "./agent-loop.js";
import { SlotManager } from "../llm/slot-manager.js";
import { openAiToolCallAdapter } from "../llm/provider/openai/openai-tool-call-adapter.js";
import {
  buildGrammar,
  grammarToolNames,
} from "../llm/grammar/build-grammar.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { ReflectionRunner } from "../memory/reflection/reflection-runner.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * The three runtime seams a fusion worker turn rides on:
 *   - `providerId` pins the turn: the step is built for the pinned
 *     link's wire shape and the pin reaches `llmComplete`;
 *   - `ephemeral` keeps the turn out of the memory fabric;
 *   - `toolFilter` hides tools from the step (and from the native wire).
 */

function makeCompletion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {
      promptMs: 1,
      predictedMs: 1,
      promptTokens: 10,
      predictedTokens: 5,
    },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

const TOOLS: ToolDescriptor[] = [
  {
    name: "reply",
    summary: "Reply to the user.",
    argsSchema: '{"text": string}',
  },
  {
    name: "finish",
    summary: "Finish the session.",
    argsSchema: '{"summary": string}',
  },
  {
    name: "os.fs.read",
    summary: "Read a file.",
    argsSchema: '{"path": string}',
  },
];

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const SKILLS: SkillCatalogEntry[] = [];

function turnOptions(extra: Partial<RunTurnOptions> = {}): RunTurnOptions {
  return {
    userMessage: "do the thing",
    maxSteps: 2,
    signal: new AbortController().signal,
    ...extra,
  };
}

describe("AgentLoop fusion seams", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-fusion-seams-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("a pinned turn is built for the resolved slice and forwards providerId to llmComplete", async () => {
    const seen: LlmStreamParams[] = [];
    const resolvedFor: string[] = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      // The ACTIVE provider is grammar with slot affinity; the pinned
      // one is native-tools without it. The step must follow the pin.
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: true,
      resolveLlmSlice: (providerId) => {
        resolvedFor.push(providerId);
        return {
          toolTransport: "native_tools",
          toolCallAdapter: openAiToolCallAdapter,
          supportsSlotAffinity: false,
          supportsParallelTools: true,
        };
      },
      llmComplete: async (params) => {
        seen.push(params);
        return makeCompletion("done");
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s-w-pinned", workingDir });
    const result = await loop.runTurn(
      session,
      turnOptions({ providerId: "local-x" }),
    );
    expect(result.reason).toBe("reply");
    expect(resolvedFor).toEqual(["local-x"]);
    expect(seen).toHaveLength(1);
    const params = seen[0]!;
    expect(params.providerId).toBe("local-x");
    // Native wire shape from the slice, not the grammar-only global.
    expect(params.tools).toBeDefined();
    expect(params.tools!.length).toBeGreaterThan(0);
    // No slot affinity on the pinned link ⇒ slotId -1.
    expect(params.slotId).toBe(-1);
  });

  it("an unpinned turn never resolves a slice and carries no providerId", async () => {
    const seen: LlmStreamParams[] = [];
    let resolved = 0;
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      resolveLlmSlice: () => {
        resolved += 1;
        throw new Error("must not be called");
      },
      llmComplete: async (params) => {
        seen.push(params);
        return makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "hi" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s-plain", workingDir });
    await loop.runTurn(session, turnOptions());
    expect(resolved).toBe(0);
    expect(seen[0]!.providerId).toBeUndefined();
  });

  it("ephemeral: no memory recall, no reflection, no lesson lifecycle", async () => {
    let recalls = 0;
    let reflections = 0;
    let lessonBumps = 0;
    const memoryContextProvider: MemoryContextProvider = {
      buildMemoryContext() {
        recalls += 1;
        return {
          recalled: [],
          index: [],
          lessons: [
            {
              id: 7,
              activation: "l",
              tags: [],
              workingDir: null,
              updatedAt: 1,
            },
          ],
        };
      },
    };
    const reflectionRunner: ReflectionRunner = {
      async reflect() {
        reflections += 1;
      },
      abortPending() {},
    };
    const lessonLifecycle: LessonLifecycleHook = {
      recordTurnOutcome() {
        lessonBumps += 1;
      },
    };
    const build = () =>
      new AgentLoop({
        registry: buildDefaultToolRegistry(),
        slotManager: new SlotManager(2),
        grammar: 'root ::= "ok"',
        llmComplete: async () =>
          makeCompletion(
            JSON.stringify({ tool: "reply", args: { text: "hi" } }),
          ),
        toolDescriptors: TOOLS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        memoryContextProvider,
        reflectionRunner,
        lessonLifecycle,
      });

    // Control: the same wiring on an ordinary turn touches all three.
    const plain = await build().runTurn(
      createEmptySessionState({ id: "s-plain", workingDir }),
      turnOptions(),
    );
    expect(plain.reason).toBe("reply");
    expect(recalls).toBeGreaterThan(0);
    expect(reflections).toBe(1);
    expect(lessonBumps).toBe(1);

    recalls = 0;
    reflections = 0;
    lessonBumps = 0;
    const worker = await build().runTurn(
      createEmptySessionState({ id: "s-w-ephemeral", workingDir }),
      turnOptions({ ephemeral: true }),
    );
    expect(worker.reason).toBe("reply");
    expect(recalls).toBe(0);
    expect(reflections).toBe(0);
    expect(lessonBumps).toBe(0);
  });

  it("toolFilter removes the descriptor from the step, and from the native tools payload", async () => {
    const seen: LlmStreamParams[] = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      toolTransport: "native_tools",
      toolCallAdapter: openAiToolCallAdapter,
      supportsSlotAffinity: false,
      llmComplete: async (params) => {
        seen.push(params);
        return makeCompletion("done");
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s-w-filtered", workingDir });
    await loop.runTurn(
      session,
      turnOptions({ toolFilter: (name) => name !== "os.fs.read" }),
    );
    // Wire names are adapter-sanitised (`os.fs.read` → `os__fs__read`);
    // the point is which descriptors made it onto the wire at all. Note
    // the adapter appends `reply` / `finish` unconditionally, so those
    // two can only be hidden from the prompt catalog, never from the
    // native wire — the filter is a hard removal for everything else.
    const names = (seen[0]!.tools ?? []).map(
      (t) => (t as { function?: { name?: string } }).function?.name ?? "",
    );
    expect(names).toContain("reply");
    expect(names.some((n) => n.includes("fs") && n.includes("read"))).toBe(
      false,
    );
    // The prompt's tool catalog is built from the same descriptors.
    expect(seen[0]!.prompt).not.toContain("Read a file.");
    expect(seen[0]!.prompt).toContain("Reply to the user.");
    // ...and so is the per-request grammar a local fallback link would
    // get: the hidden tool is not merely undescribed but unemittable.
    const admitted = grammarToolNames(seen[0]!.grammar);
    expect(admitted).not.toBeNull();
    expect(admitted).not.toContain("os.fs.read");
    expect(admitted).toContain("reply");
  });

  it("an orchestrator turn drops the gate's refusals from the request grammar and keeps their descriptors in the prompt", async () => {
    // D2 end to end: a LOCAL orchestrator (grammar transport) must not
    // be able to generate the write the gate would refuse — Gemma spent
    // 22 minutes on exactly that — while the prefix bytes stay those of
    // any other turn, so the session's KV cache survives.
    const seen: LlmStreamParams[] = [];
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const tools: ToolDescriptor[] = [
      ...TOOLS,
      {
        name: "os.fs.write",
        summary: "Write a file.",
        argsSchema: '{"path": string, "content": string}',
      },
      {
        name: "fusion.delegate",
        summary: "Fan out.",
        argsSchema: '{"tasks": array}',
      },
    ];
    // The gate reads mutability off the REGISTRY (an unregistered name
    // passes through), so the tools it must refuse have to be registered.
    const registry = buildDefaultToolRegistry();
    for (const [name, readonly] of [
      ["os.fs.read", true],
      ["os.fs.write", false],
      ["fusion.delegate", false],
    ] as const) {
      if (registry.has(name)) continue;
      registry.register({
        name,
        description: name,
        readonly,
        async run() {
          return {
            tool: name,
            status: "ok",
            summary: name,
            details: {},
            truncated: false,
          };
        },
      });
    }
    const makeLoop = (isFusionMode: boolean) =>
      new AgentLoop({
        registry,
        slotManager: new SlotManager(2),
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        llmComplete: async (params) => {
          seen.push(params);
          return makeCompletion(
            JSON.stringify([{ tool: "reply", args: { text: "done" } }]),
          );
        },
        toolDescriptors: tools,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        isFusionMode: () => isFusionMode,
      });
    await makeLoop(true).runTurn(
      createEmptySessionState({ id: "s-orch", workingDir }),
      turnOptions(),
    );
    await makeLoop(false).runTurn(
      createEmptySessionState({ id: "s-plain", workingDir }),
      turnOptions(),
    );
    const [orchestrator, plain] = seen;
    const names = grammarToolNames(orchestrator!.grammar);
    expect(names).not.toBeNull();
    expect(names).not.toContain("os.fs.write");
    expect(names).toContain("os.fs.read");
    expect(names).toContain("fusion.delegate");
    expect(names).toContain("reply");
    expect(names).toContain("finish");
    // The plain turn gets the base grammar untouched.
    expect(plain!.grammar).toBe(grammar);
    // The orchestrator ROLE shapes the prefix (per role, stable within
    // the turn): the write tool is listed by name, not described in
    // full, and nothing about the gate's per-call refusals touches it.
    expect(orchestrator!.prompt).toContain("# also available via `tool.view`:");
    expect(orchestrator!.prompt).toContain("os.fs.write");
    expect(orchestrator!.prompt).not.toContain("- os.fs.write —");
    expect(orchestrator!.prompt).toContain("- fusion.delegate —");
    // The plain turn is `full`: everything in full, no names line.
    expect(plain!.prompt).toContain("- os.fs.write —");
    expect(plain!.prompt).not.toContain("# also available via `tool.view`:");
  });

  it("a worker's builder role reaches the step and its request", async () => {
    const seen: LlmStreamParams[] = [];
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const tools: ToolDescriptor[] = [
      ...TOOLS,
      {
        name: "os.fs.write",
        summary: "Write a file.",
        argsSchema: '{"path": string, "content": string}',
      },
      {
        name: "tasks.cron",
        summary: "Cron a task.",
        argsSchema: '{"cron": string}',
      },
    ];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar,
      profile: PLAIN_INSTRUCT_PROFILE,
      llmComplete: async (params) => {
        seen.push(params);
        return makeCompletion(
          JSON.stringify([{ tool: "reply", args: { text: "done" } }]),
        );
      },
      toolDescriptors: tools,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    await loop.runTurn(
      createEmptySessionState({ id: "s-builder", workingDir }),
      turnOptions({ toolRole: "builder", ephemeral: true }),
    );
    const names = grammarToolNames(seen[0]!.grammar);
    expect(names).toEqual(["os.fs.read", "os.fs.write", "reply"]);
    expect(seen[0]!.prompt).toContain("- os.fs.write —");
    expect(seen[0]!.prompt).not.toContain("- tasks.cron —");
    expect(seen[0]!.prompt).toContain("# also available via `tool.view`: finish, tasks.cron");
  });
});

/**
 * A review that only reads is made to choose (F41), end to end: the
 * count lives in the loop, the notice rides `### notice`, the cut rides
 * the step's grammar, and `step_finished` says which phase a step ran
 * under. `N` is the config default (6) — the test state dir carries no
 * override — so the notice lands on step 6 and the cut on step 12.
 */
describe("AgentLoop stalled Fusion review (F41)", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-review-stall-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const tools: ToolDescriptor[] = [
    ...TOOLS,
    {
      name: "fusion.delegate",
      summary: "Fan out.",
      argsSchema: '{"tasks": array}',
    },
  ];

  /** Fakes only: a real `fusion.delegate` would refuse outside fusion mode. */
  function makeRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    for (const [name, readonly] of [
      ["os.fs.read", true],
      ["fusion.delegate", false],
      ["reply", true],
      ["finish", true],
    ] as const) {
      registry.register({
        name,
        description: name,
        readonly,
        async run() {
          return {
            tool: name,
            status: "ok",
            summary: name,
            details: {},
            truncated: false,
          };
        },
      });
    }
    return registry;
  }

  type Stalls = Array<{ stepIndex: number; reviewStall?: unknown }>;

  /**
   * Run an orchestrator turn whose model emits `script(step)` on each
   * step; a step past the script replies. Returns every request the
   * model saw and every `step_finished` event.
   */
  async function runScripted(
    script: (step: number) => string | null,
    userMessage = "do the thing",
  ): Promise<{ seen: LlmStreamParams[]; finished: Stalls }> {
    const seen: LlmStreamParams[] = [];
    const finished: Stalls = [];
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const loop = new AgentLoop({
      registry: makeRegistry(),
      slotManager: new SlotManager(2),
      grammar,
      profile: PLAIN_INSTRUCT_PROFILE,
      llmComplete: async (params) => {
        const step = seen.length;
        seen.push(params);
        return makeCompletion(
          script(step) ??
            JSON.stringify([{ tool: "reply", args: { text: "done" } }]),
        );
      },
      toolDescriptors: tools,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      isFusionMode: () => true,
      onEvent: (event: AgentLoopEvent) => {
        if (event.type === "step_finished") {
          finished.push({
            stepIndex: event.stepIndex,
            ...(event.reviewStall !== undefined
              ? { reviewStall: event.reviewStall }
              : {}),
          });
        }
      },
    });
    await loop.runTurn(
      createEmptySessionState({ id: "s-stall", workingDir }),
      turnOptions({ userMessage, maxSteps: 40, autoContinue: false }),
    );
    return { seen, finished };
  }

  const read = (step: number): string =>
    JSON.stringify([{ tool: "os.fs.read", args: { path: `f${step}` } }]);
  const delegate = JSON.stringify([
    { tool: "fusion.delegate", args: { tasks: [{ id: "t1", instructions: "fix" }] } },
  ]);

  it("notices once at N, cuts the tool set at 2N, and restores it after a fan-out", async () => {
    // Twelve steps of distinct reads, a fan-out on the cut step, one
    // more read, then a reply.
    const { seen, finished } = await runScripted((step) =>
      step < 12 ? read(step) : step === 12 ? delegate : step === 13 ? read(step) : null,
    );
    expect(seen).toHaveLength(15);
    const notice = "6 steps of reading and no fan-out";
    for (let step = 0; step < 12; step += 1) {
      expect(seen[step]!.prompt.includes(notice), `notice at ${step}`).toBe(
        step === 6,
      );
      expect(grammarToolNames(seen[step]!.grammar), `grammar at ${step}`).toContain(
        "os.fs.read",
      );
    }
    expect(seen[6]!.prompt).toContain(
      "In Fusion you cannot edit; a fix means `fusion.delegate` with the change spelled out, or `reply` with what stands. Next step: delegate or reply.",
    );
    // The cut step: the notice again, and a grammar of the three names.
    expect(seen[12]!.prompt).toContain("12 steps of reading and no fan-out");
    expect(seen[12]!.prompt).toContain(
      "This step runs only `fusion.delegate`, `reply` or `finish`",
    );
    expect(grammarToolNames(seen[12]!.grammar)).toEqual([
      "finish",
      "fusion.delegate",
      "reply",
    ]);
    // The catalog never moved: same prompt prefix bytes on every step.
    const prefixOf = (prompt: string): string => prompt.split("### conversation")[0]!;
    expect(prefixOf(seen[12]!.prompt)).toBe(prefixOf(seen[0]!.prompt));
    // After the fan-out the full set is back and the count starts over.
    expect(grammarToolNames(seen[13]!.grammar)).toContain("os.fs.read");
    expect(seen[13]!.prompt).not.toContain("steps of reading and no fan-out");
    // The trace says which phase each step ran under.
    const byStep = new Map(finished.map((f) => [f.stepIndex, f.reviewStall]));
    expect(byStep.get(5)).toBeUndefined();
    expect(byStep.get(6)).toEqual({ steps: 6, phase: "notice" });
    expect(byStep.get(11)).toEqual({ steps: 11, phase: "notice" });
    expect(byStep.get(12)).toEqual({ steps: 12, phase: "cut" });
    expect(byStep.get(13)).toBeUndefined();
  });

  it("a repair request halves N: the notice at 3, the cut at 6", async () => {
    const { seen } = await runScripted(
      (step) => (step < 6 ? read(step) : step === 6 ? delegate : null),
      "checker output:\nFAIL test_login — expected 200, got 500",
    );
    expect(seen[2]!.prompt).not.toContain("steps of reading and no fan-out");
    expect(seen[3]!.prompt).toContain("3 steps of reading and no fan-out");
    expect(seen[4]!.prompt).not.toContain("steps of reading and no fan-out");
    expect(grammarToolNames(seen[5]!.grammar)).toContain("os.fs.read");
    expect(grammarToolNames(seen[6]!.grammar)).toEqual([
      "finish",
      "fusion.delegate",
      "reply",
    ]);
  });

  it("a turn that delegates on step 2 never sees the notice or the cut", async () => {
    const { seen, finished } = await runScripted((step) =>
      step < 2 ? read(step) : step === 2 ? delegate : step < 8 ? read(step) : null,
    );
    expect(seen).toHaveLength(9);
    for (const params of seen) {
      expect(params.prompt).not.toContain("steps of reading and no fan-out");
      expect(grammarToolNames(params.grammar)).toContain("os.fs.read");
    }
    expect(finished.every((f) => f.reviewStall === undefined)).toBe(true);
  });
});
