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
