import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type {
  MemoryContextProvider,
  ReflectionSegmentationConfig,
} from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { SessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import type {
  ReflectionInput,
  ReflectionRunner,
} from "../memory/reflection/reflection-runner.js";

/**
 * Phase B (memU-inspired) — sliding-window reflection segmentation.
 *
 * Pins:
 *   - Segmentation disabled → legacy per-reply trigger, no transcript
 *     attached, byte-stable with pre-config-v18 callers.
 *   - Segmentation enabled → reflection fires only on the cadence
 *     turn (`state.turnCount % triggerEveryTurns === 0`) OR on a
 *     `finish` terminal.
 *   - `finish` always triggers the final flush so the trailing
 *     partial window is never lost.
 *   - When firing, the transcript array carries the trailing W
 *     user/assistant pairs in chronological order; the trailing
 *     pair's content mirrors `userMessage` / `assistantReply` so
 *     the runner contract stays satisfied.
 *   - Cross-session parallelism is untouched: a fire on session A
 *     records nothing on session B (each `ReflectionRunner` call
 *     carries the correct `sessionId`).
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

const NOOP_PROVIDER: MemoryContextProvider = {
  buildMemoryContext: () => ({
    recalled: [],
    index: [],
  }),
};

interface ReflectCall {
  sessionId: string;
  userMessage: string;
  assistantReply: string;
  transcript: readonly { user: string; assistant: string }[] | undefined;
}

function captureReflectionRunner(calls: ReflectCall[]): ReflectionRunner {
  return {
    async reflect(input: ReflectionInput) {
      calls.push({
        sessionId: input.sessionId,
        userMessage: input.userMessage,
        assistantReply: input.assistantReply,
        transcript: input.transcript,
      });
    },
    abortPending() {
      // no-op
    },
  };
}

function makeReplyLoop(deps: {
  reflectionCalls: ReflectCall[];
  segmentation?: ReflectionSegmentationConfig;
  replyText?: string;
}): AgentLoop {
  return new AgentLoop({
    registry: buildDefaultToolRegistry(),
    slotManager: new SlotManager(2),
    grammar: 'root ::= "ok"',
    llmComplete: async () =>
      makeCompletion(
        JSON.stringify({
          tool: "reply",
          args: { text: deps.replyText ?? "ok" },
        }),
      ),
    toolDescriptors: TOOLS,
    capabilities: CAPS,
    skillCatalog: SKILLS,
    memoryContextProvider: NOOP_PROVIDER,
    reflectionRunner: captureReflectionRunner(deps.reflectionCalls),
    ...(deps.segmentation
      ? { reflectionSegmentation: deps.segmentation }
      : {}),
  });
}

function makeFinishLoop(deps: {
  reflectionCalls: ReflectCall[];
  segmentation?: ReflectionSegmentationConfig;
}): AgentLoop {
  return new AgentLoop({
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
    memoryContextProvider: NOOP_PROVIDER,
    reflectionRunner: captureReflectionRunner(deps.reflectionCalls),
    ...(deps.segmentation
      ? { reflectionSegmentation: deps.segmentation }
      : {}),
  });
}

describe("AgentLoop reflection segmentation (phase B)", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-segmentation-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("disabled (default): fires reflection on every reply without a transcript", async () => {
    const calls: ReflectCall[] = [];
    const loop = makeReplyLoop({ reflectionCalls: calls, replyText: "hi" });
    const session = createEmptySessionState({ id: "s1", workingDir });
    await loop.runTurn(session, {
      userMessage: "hello",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sessionId).toBe("s1");
    expect(calls[0]!.userMessage).toBe("hello");
    expect(calls[0]!.assistantReply).toBe("hi");
    expect(calls[0]!.transcript).toBeUndefined();
  });

  it("enabled: skips reflection on intermediate turns and fires on cadence turn with transcript window", async () => {
    const calls: ReflectCall[] = [];
    const loop = makeReplyLoop({
      reflectionCalls: calls,
      segmentation: { enabled: true, triggerEveryTurns: 3, windowTurns: 5 },
    });
    let session: SessionState = createEmptySessionState({ id: "s2", workingDir });
    for (let n = 1; n <= 3; n += 1) {
      const result = await loop.runTurn(session, {
        userMessage: `msg ${n}`,
        maxSteps: 2,
        signal: new AbortController().signal,
      });
      session = result.session;
    }
    expect(calls).toHaveLength(1);
    const fire = calls[0]!;
    expect(fire.sessionId).toBe("s2");
    expect(fire.transcript).toBeDefined();
    expect(fire.transcript!.map((p) => p.user)).toEqual([
      "msg 1",
      "msg 2",
      "msg 3",
    ]);
    expect(fire.userMessage).toBe("msg 3");
  });

  it("enabled: transcript window keeps only the last W pairs", async () => {
    const calls: ReflectCall[] = [];
    const loop = makeReplyLoop({
      reflectionCalls: calls,
      segmentation: { enabled: true, triggerEveryTurns: 2, windowTurns: 2 },
    });
    let session: SessionState = createEmptySessionState({ id: "s3", workingDir });
    for (let n = 1; n <= 4; n += 1) {
      const result = await loop.runTurn(session, {
        userMessage: `t${n}`,
        maxSteps: 2,
        signal: new AbortController().signal,
      });
      session = result.session;
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]!.transcript!.map((p) => p.user)).toEqual(["t1", "t2"]);
    expect(calls[1]!.transcript!.map((p) => p.user)).toEqual(["t3", "t4"]);
  });

  it("enabled: 'finish' always triggers the final flush even mid-cadence", async () => {
    const calls: ReflectCall[] = [];
    const replyLoop = makeReplyLoop({
      reflectionCalls: calls,
      segmentation: { enabled: true, triggerEveryTurns: 5, windowTurns: 4 },
    });
    let session: SessionState = createEmptySessionState({ id: "s4", workingDir });
    const r1 = await replyLoop.runTurn(session, {
      userMessage: "first",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    session = r1.session;
    expect(calls).toHaveLength(0);

    const finishLoop = makeFinishLoop({
      reflectionCalls: calls,
      segmentation: { enabled: true, triggerEveryTurns: 5, windowTurns: 4 },
    });
    const r2 = await finishLoop.runTurn(session, {
      userMessage: "wrap up",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(r2.reason).toBe("finish");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.transcript!.map((p) => p.user)).toContain("first");
  });

  it("enabled: cross-session reflections stay scoped to their own sessionId", async () => {
    const calls: ReflectCall[] = [];
    const loop = makeReplyLoop({
      reflectionCalls: calls,
      segmentation: { enabled: true, triggerEveryTurns: 1, windowTurns: 3 },
    });
    let sessionA: SessionState = createEmptySessionState({
      id: "session-A",
      workingDir,
    });
    let sessionB: SessionState = createEmptySessionState({
      id: "session-B",
      workingDir,
    });
    const ra = await loop.runTurn(sessionA, {
      userMessage: "a-msg",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    sessionA = ra.session;
    const rb = await loop.runTurn(sessionB, {
      userMessage: "b-msg",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    sessionB = rb.session;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sessionId).toBe("session-A");
    expect(calls[0]!.transcript!.map((p) => p.user)).toEqual(["a-msg"]);
    expect(calls[1]!.sessionId).toBe("session-B");
    expect(calls[1]!.transcript!.map((p) => p.user)).toEqual(["b-msg"]);
  });

  it("enabled: a 'finish' on an empty session skips reflection (no pairs to extract)", async () => {
    const calls: ReflectCall[] = [];
    const finishLoop = makeFinishLoop({
      reflectionCalls: calls,
      segmentation: { enabled: true, triggerEveryTurns: 5, windowTurns: 4 },
    });
    const session: SessionState = createEmptySessionState({
      id: "s-empty",
      workingDir,
    });
    const result = await finishLoop.runTurn(session, {
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("finish");
    expect(calls).toHaveLength(0);
  });
});
