import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import { FINALIZATION_REQUEST_DEADLINE_MS } from "./request-deadline.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { SessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { CapabilitiesSummary, ToolDescriptor } from "../prompt/stable-prefix.js";

/**
 * A task paused at its time ceiling whose summary step also runs out of
 * time still tells the user what was done: the stop reply carries a digest
 * built from the turn's own records. A summary the model does write is
 * left exactly as it was.
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
  { name: "os.fs.read", summary: "Read.", argsSchema: '{"path": string}' },
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

function lastReply(session: SessionState): string | undefined {
  for (let i = session.turns.length - 1; i >= 0; i -= 1) {
    const turn = session.turns[i];
    if (turn?.kind === "assistant_reply") return turn.text;
  }
  return undefined;
}

describe("AgentLoop pause digest", () => {
  let workingDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    workingDir = mkdtempSync(join(tmpdir(), "atomic-pause-digest-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(workingDir, { recursive: true, force: true });
  });

  /** Step 1 reads a file, step 2 hangs past the ceiling, step 3 is the summary. */
  function loop(summary: (signal: AbortSignal | undefined) => Promise<string>) {
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "Read a file.",
      readonly: true,
      run: async () =>
        compressToolResult({ tool: "os.fs.read", status: "ok", output: "hello", details: {} }),
    });
    let call = 0;
    return new AgentLoop({
      registry,
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async (params) => {
        call += 1;
        if (call === 1) {
          return completion(JSON.stringify([{ tool: "os.fs.read", args: { path: "notes.txt" } }]));
        }
        if (call === 2) return completion(await hangUntilAborted(params.signal));
        return completion(await summary(params.signal));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
    });
  }

  function run(agent: AgentLoop) {
    return agent.runTurn(createEmptySessionState({ id: "s-digest", workingDir }), {
      userMessage: "tidy the notes",
      maxSteps: 10,
      taskMaxSteps: 10,
      taskMaxDurationMs: 30_000,
      signal: new AbortController().signal,
    });
  }

  it("falls back to a summary from the turn's records when the summary step times out", async () => {
    const turn = run(loop((signal) => hangUntilAborted(signal)));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(FINALIZATION_REQUEST_DEADLINE_MS);
    const result = await turn;
    expect(result.reason).toBe("max_steps");
    expect(result.stopCause).toBe("time_ceiling");
    const text = lastReply(result.session);
    expect(text).toMatch(/^\(paused: this task hit its time limit/);
    expect(text).toContain("Summary from this task's log");
    expect(text).toContain('- Request: "tidy the notes"');
    expect(text).toContain("- Tool calls: 1 (1 ok, 0 failed)");
    expect(text).toMatch(/os\.fs\.read \S*notes\.txt \(ok\)/);
  });

  it("keeps the model's own summary unchanged when the summary step answers", async () => {
    const turn = run(loop(async () => JSON.stringify([{ tool: "reply", args: { text: "read the notes; nothing left" } }])));
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await turn;
    expect(result.reason).toBe("reply");
    expect(result.stopCause).toBe("time_ceiling");
    expect(lastReply(result.session)).toBe("read the notes; nothing left");
  });
});
