import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop, type AgentLoopEvent } from "./agent-loop.js";
import type { LocalOutOfMemoryPort } from "./agent-contract.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { LocalOutOfMemoryError, TransportError } from "../llm/index.js";
import { attachFailingLink } from "../llm/fallback/failed-attempts.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CapabilitiesSummary, ToolDescriptor } from "../prompt/stable-prefix.js";

/**
 * ATO-334 end to end through the loop: a 500 from a local model that ran
 * out of memory restarts it with half the window and the same step gets
 * its answer, instead of a five-minute wait. Three restarts in a row with
 * no step completed end the turn with plain text.
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

function outOfMemory500(): TransportError {
  const err = new TransportError("llama-server returned 500", 500, "http://127.0.0.1:8080/completion");
  attachFailingLink(err, "local-llama");
  return err;
}

describe("AgentLoop: local model out of memory", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-oom-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function setup(failures: number) {
    const events: AgentLoopEvent[] = [];
    let window = 262_144;
    let calls = 0;
    const port: LocalOutOfMemoryPort = {
      detect: vi.fn(() => ({ contextWindow: window })),
      canRestart: () => true,
      ask: vi.fn(async () => "restart_smaller" as const),
      restart: vi.fn(async (next: number) => {
        window = next;
        return true;
      }),
    };
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async () => {
        calls += 1;
        if (calls <= failures) throw outOfMemory500();
        return completion(JSON.stringify([{ tool: "reply", args: { text: "hello" } }]));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      localOutOfMemory: port,
      onEvent: (event) => events.push(event),
    });
    return { loop, port, events, calls: () => calls };
  }

  it("the first message gets its answer after one restart with half the window", async () => {
    const { loop, port, events } = setup(1);
    const result = await loop.runTurn(createEmptySessionState({ id: "s-oom-1", workingDir }), {
      userMessage: "hi",
      maxSteps: 5,
      taskMaxSteps: 5,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(port.restart).toHaveBeenCalledTimes(1);
    expect(port.restart).toHaveBeenCalledWith(131_072, expect.any(AbortSignal));
    // Unattended by default: nobody was asked.
    expect(port.ask).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "provider_waiting")).toBe(false);
    const notes = events.filter((e) => e.type === "local_model_out_of_memory" && e.phase === "restarted");
    expect(notes).toHaveLength(1);
  });

  it("asks first when the turn has someone to ask", async () => {
    const { loop, port, events } = setup(1);
    const result = await loop.runTurn(createEmptySessionState({ id: "s-oom-ask", workingDir }), {
      userMessage: "hi",
      maxSteps: 5,
      taskMaxSteps: 5,
      signal: new AbortController().signal,
      localOutOfMemory: "ask",
    });
    expect(result.reason).toBe("reply");
    expect(port.ask).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "local_model_out_of_memory" && e.phase === "asking")).toBe(true);
  });

  it("stops after three restarts in a row with plain text", async () => {
    const { loop, port, events } = setup(10);
    const result = await loop.runTurn(createEmptySessionState({ id: "s-oom-3", workingDir }), {
      userMessage: "hi",
      maxSteps: 5,
      taskMaxSteps: 5,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("failed");
    expect(port.restart).toHaveBeenCalledTimes(3);
    expect(vi.mocked(port.restart).mock.calls.map((call) => call[0])).toEqual([131_072, 65_536, 32_768]);
    expect(result.session.lastError).toBe(
      "The model ran out of memory 3 times in a row, even with a context window of 32768 tokens. Pick a smaller model.",
    );
    const failed = events.find((e) => e.type === "loop_failed");
    expect(failed?.type === "loop_failed" ? failed.error : null).toBeInstanceOf(LocalOutOfMemoryError);
    expect(events.filter((e) => e.type === "loop_completed")).toHaveLength(1);
  });
});
