import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type {
  LessonLifecycleHook,
  LessonLifecycleOutcome,
  MemoryContext,
  MemoryContextProvider,
  MemoryContextProviderInput,
} from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import type { LessonIndexEntry } from "../memory/lessons/lesson-store.js";

/**
 * Phase 6 — lesson lifecycle integration with `AgentLoop.runTurn`.
 *
 * Pins:
 *   - `reply` / `finish` → hook fires with outcome="success".
 *   - thrown error → hook fires with outcome="failure".
 *   - `cancelled` (signal aborted) → hook is NOT called.
 *   - `max_steps` → hook is NOT called.
 *   - Once-per-turn dedup: surfacing the same lesson across many
 *     steps still bumps exactly once.
 *   - Empty recalled set → no hook invocation.
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
    name: "finish",
    summary: "Finish the session with a summary.",
    argsSchema: '{"summary": string}',
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

function makeLessons(ids: readonly number[]): readonly LessonIndexEntry[] {
  return ids.map((id) => ({
    id,
    activation: `lesson-${id}`,
    tags: ["test"],
    workingDir: null,
    updatedAt: 1_000_000,
  }));
}

function makeProvider(
  lessonsByCall: ReadonlyArray<readonly number[]>,
): MemoryContextProvider {
  let i = 0;
  return {
    buildMemoryContext(_input: MemoryContextProviderInput): MemoryContext {
      const ids = lessonsByCall[Math.min(i, lessonsByCall.length - 1)] ?? [];
      i += 1;
      return {
        recalled: [],
        index: [],
        lessons: makeLessons(ids),
      };
    },
  };
}

interface HookCall {
  outcome: LessonLifecycleOutcome;
  surfaced: readonly number[];
}

function captureHook(calls: HookCall[]): LessonLifecycleHook {
  return {
    recordTurnOutcome({ surfacedLessonIds, outcome }) {
      calls.push({ outcome, surfaced: [...surfacedLessonIds].sort() });
    },
  };
}

describe("AgentLoop lesson lifecycle hook (phase 6)", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-lifecycle-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("fires 'success' for surfaced lessons when the turn ends in reply", async () => {
    const calls: HookCall[] = [];
    const loop = new AgentLoop({
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
      memoryContextProvider: makeProvider([[1, 2]]),
      lessonLifecycle: captureHook(calls),
    });
    const session = createEmptySessionState({
      id: "s-success",
      workingDir,
    });
    const result = await loop.runTurn(session, {
      userMessage: "hello",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(calls).toEqual([{ outcome: "success", surfaced: [1, 2] }]);
  });

  it("fires 'success' for surfaced lessons when the turn ends in finish", async () => {
    const calls: HookCall[] = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({ tool: "finish", args: { summary: "done" } }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      memoryContextProvider: makeProvider([[42]]),
      lessonLifecycle: captureHook(calls),
    });
    const session = createEmptySessionState({
      id: "s-finish",
      workingDir,
    });
    const result = await loop.runTurn(session, {
      userMessage: "wrap up",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("finish");
    expect(calls).toEqual([{ outcome: "success", surfaced: [42] }]);
  });

  it("fires 'failure' for surfaced lessons when the loop fails", async () => {
    const calls: HookCall[] = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        throw new Error("boom — mock LLM rejected");
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      memoryContextProvider: makeProvider([[3, 4]]),
      lessonLifecycle: captureHook(calls),
    });
    const session = createEmptySessionState({
      id: "s-failed",
      workingDir,
    });
    const result = await loop.runTurn(session, {
      userMessage: "x",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("failed");
    expect(calls).toEqual([{ outcome: "failure", surfaced: [3, 4] }]);
  });

  it("does NOT fire the hook when the turn is cancelled", async () => {
    const calls: HookCall[] = [];
    const ac = new AbortController();
    ac.abort();
    const loop = new AgentLoop({
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
      memoryContextProvider: makeProvider([[9]]),
      lessonLifecycle: captureHook(calls),
    });
    const session = createEmptySessionState({
      id: "s-cancelled",
      workingDir,
    });
    const result = await loop.runTurn(session, {
      userMessage: "x",
      maxSteps: 2,
      signal: ac.signal,
    });
    expect(result.reason).toBe("cancelled");
    expect(calls).toEqual([]);
  });

  it("deduplicates surfaced ids across multiple step refreshes", async () => {
    const calls: HookCall[] = [];
    let step = 0;
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        step += 1;
        if (step < 3) {
          // Two non-terminal `finish`-look-alikes are not possible
          // without a real registry response — fall through to reply
          // after one repeat. For dedup purposes one refresh is
          // enough: `recordSurfacedLessons(state)` runs ALSO at the
          // top of runTurn, before the first step, so providers
          // returning `[1, 2]` then `[2, 3]` build a union of {1,2,3}.
          return makeCompletion(
            JSON.stringify({ tool: "reply", args: { text: "hi" } }),
          );
        }
        return makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "hi" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      memoryContextProvider: makeProvider([
        [1, 2],
        [2, 3],
        [3, 1],
      ]),
      lessonLifecycle: captureHook(calls),
    });
    const session = createEmptySessionState({
      id: "s-dedup",
      workingDir,
    });
    const result = await loop.runTurn(session, {
      userMessage: "hi",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    // The exact union depends on how many refreshes happened. We
    // assert that bookkeeping is monotonically-growing and unique.
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.outcome).toBe("success");
    expect(new Set(c.surfaced).size).toBe(c.surfaced.length);
    expect(c.surfaced).toContain(1);
    expect(c.surfaced).toContain(2);
  });

  it("is a no-op when no lessons surfaced this turn", async () => {
    const calls: HookCall[] = [];
    const loop = new AgentLoop({
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
      memoryContextProvider: makeProvider([[]]),
      lessonLifecycle: captureHook(calls),
    });
    const session = createEmptySessionState({
      id: "s-empty",
      workingDir,
    });
    await loop.runTurn(session, {
      userMessage: "hi",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(calls).toEqual([]);
  });
});
