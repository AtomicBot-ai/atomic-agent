import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { RunTurnOptions } from "./agent-loop.js";
import type { LlmStreamParams } from "./step-executor.js";
import { FINALIZATION_REQUEST_DEADLINE_MS } from "./request-deadline.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * F15 — the task's wall-clock ceiling holds while a request is waiting
 * on a provider. Each completion request carries the remaining task
 * time as a deadline; one that fires mid-request ends the step as
 * `time_ceiling` and the summary step runs on its own five minutes.
 */

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

const replyCall = (text: string) =>
  JSON.stringify([{ tool: "reply", args: { text } }]);

const TOOLS: ToolDescriptor[] = [
  { name: "reply", summary: "Reply to the user.", argsSchema: '{"text": string}' },
  { name: "finish", summary: "Finish the session.", argsSchema: '{"summary": string}' },
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

/** A request that answers only when its signal aborts — a provider wait. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(new Error("The operation was aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("The operation was aborted")),
      { once: true },
    );
  });
}

describe("AgentLoop request deadline (F15)", () => {
  let workingDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    workingDir = mkdtempSync(join(tmpdir(), "atomic-request-deadline-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(workingDir, { recursive: true, force: true });
  });

  interface Seen {
    call: number;
    prompt: string;
    signal: AbortSignal | undefined;
    abortedAt: number | null;
  }

  function loop(
    script: (params: LlmStreamParams, call: number) => Promise<string>,
  ) {
    const seen: Seen[] = [];
    let call = 0;
    const warnings: string[] = [];
    const agent = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async (params) => {
        call += 1;
        const entry: Seen = {
          call,
          prompt: params.prompt,
          signal: params.signal,
          abortedAt: null,
        };
        params.signal?.addEventListener(
          "abort",
          () => {
            entry.abortedAt = Date.now();
          },
          { once: true },
        );
        seen.push(entry);
        return completion(await script(params, call));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message: string) => {
          warnings.push(message);
        },
        error: () => {},
      } as never,
    });
    return { agent, seen, warnings };
  }

  function options(extra: Partial<RunTurnOptions>): RunTurnOptions {
    return {
      userMessage: "do the thing",
      maxSteps: 10,
      taskMaxSteps: 10,
      signal: new AbortController().signal,
      ...extra,
    };
  }

  it("ends a request the ceiling fires inside as time_ceiling and runs the summary step", async () => {
    const { agent, seen, warnings } = loop((params, call) =>
      call === 1
        ? hangUntilAborted(params.signal)
        : Promise.resolve(replyCall("out of time — here is where I got")),
    );
    const startedAt = Date.now();
    const turn = agent.runTurn(
      createEmptySessionState({ id: "s-ceiling", workingDir }),
      options({ taskMaxDurationMs: 30_000 }),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.abortedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    // The abandoned request was aborted at exactly the ceiling …
    expect(seen[0]!.abortedAt).toBe(startedAt + 30_000);
    const result = await turn;
    // … and the summary step ran once, told it was the last.
    expect(seen).toHaveLength(2);
    expect(seen[1]!.prompt).toContain("This is the final allowed step");
    expect(seen[1]!.signal?.aborted).toBe(false);
    expect(result.reason).toBe("reply");
    expect(result.stopCause).toBe("time_ceiling");
    expect(result.session.status).not.toBe("failed");
    expect(result.session.status).not.toBe("cancelled");
    expect(warnings).toContain(
      "task time ceiling reached mid-request; running the summary step",
    );
  });

  it("gives the summary step its own five minutes, then preserves the max-steps outcome", async () => {
    const { agent, seen } = loop((params) => hangUntilAborted(params.signal));
    const turn = agent.runTurn(
      createEmptySessionState({ id: "s-summary", workingDir }),
      options({ taskMaxDurationMs: 30_000 }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toHaveLength(2);
    const summaryStartedAt = Date.now();
    // Well past the task ceiling, the summary request is still allowed.
    await vi.advanceTimersByTimeAsync(FINALIZATION_REQUEST_DEADLINE_MS - 1);
    expect(seen[1]!.abortedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(seen[1]!.abortedAt).toBe(
      summaryStartedAt + FINALIZATION_REQUEST_DEADLINE_MS,
    );
    const result = await turn;
    expect(seen).toHaveLength(2);
    expect(result.reason).toBe("max_steps");
    expect(result.stopCause).toBe("time_ceiling");
    expect(result.session.lastError).toMatch(/task_stopped:time_ceiling/);
  });

  it("budgets each request with the time the task has left, not the whole ceiling", async () => {
    // Step 1 legitimately takes 40 of the task's 60 seconds; the request
    // of step 2 may then use only the 20 that are left.
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "Read a file.",
      readonly: true,
      run: async () =>
        compressToolResult({
          tool: "os.fs.read",
          status: "ok",
          output: "hello",
          details: {},
        }),
    });
    const seen: Seen[] = [];
    let call = 0;
    const agent = new AgentLoop({
      registry,
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async (params) => {
        call += 1;
        const entry: Seen = {
          call,
          prompt: params.prompt,
          signal: params.signal,
          abortedAt: null,
        };
        params.signal?.addEventListener(
          "abort",
          () => {
            entry.abortedAt = Date.now();
          },
          { once: true },
        );
        seen.push(entry);
        if (call === 1) {
          await new Promise((resolve) => setTimeout(resolve, 40_000));
          return completion(
            JSON.stringify([{ tool: "os.fs.read", args: { path: "x" } }]),
          );
        }
        if (call === 2) return completion(await hangUntilAborted(params.signal));
        return completion(replyCall("done"));
      },
      toolDescriptors: [
        ...TOOLS,
        { name: "os.fs.read", summary: "Read.", argsSchema: '{"path": string}' },
      ],
      capabilities: CAPS,
      skillCatalog: [],
    });
    const startedAt = Date.now();
    const turn = agent.runTurn(
      createEmptySessionState({ id: "s-remaining", workingDir }),
      options({ taskMaxDurationMs: 60_000 }),
    );
    await vi.advanceTimersByTimeAsync(40_000);
    expect(seen).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(seen[1]!.abortedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(seen[1]!.abortedAt).toBe(startedAt + 60_000);
    const result = await turn;
    expect(seen).toHaveLength(3);
    expect(result.reason).toBe("reply");
    expect(result.stopCause).toBe("time_ceiling");
  });

  it("still reports a user abort mid-request as cancelled", async () => {
    const user = new AbortController();
    const { agent, seen } = loop((params) => hangUntilAborted(params.signal));
    const turn = agent.runTurn(
      createEmptySessionState({ id: "s-user", workingDir }),
      options({ taskMaxDurationMs: 60_000, signal: user.signal }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    user.abort();
    const result = await turn;
    expect(seen).toHaveLength(1);
    expect(result.reason).toBe("cancelled");
    expect(result).not.toHaveProperty("stopCause");
  });
});
