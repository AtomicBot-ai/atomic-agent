import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import { planLastTurnRollback } from "../session/session-truncate.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * A turn that fails after a tool already ran (ATO-1476): its failure
 * record names the tool instead of saying nothing took effect, and the
 * turn is never taken back for a "Try again" that would run it twice.
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

const sendCall = JSON.stringify([{ tool: "test.send", args: { to: "x" } }]);
const broken = '[{"tool":"reply","args":{"text":';

const TOOLS: ToolDescriptor[] = [
  { name: "reply", summary: "Reply to the user.", argsSchema: '{"text": string}' },
  { name: "finish", summary: "Finish the session.", argsSchema: '{"summary": string}' },
  { name: "test.send", summary: "Send a request.", argsSchema: '{"to": string}' },
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

describe("AgentLoop failure after a tool ran", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-failed-after-tools-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function loop(script: (call: number) => string) {
    let call = 0;
    let sends = 0;
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "test.send",
      description: "Send a request.",
      readonly: false,
      run: async () => {
        sends += 1;
        return compressToolResult({
          tool: "test.send",
          status: "ok",
          output: "sent",
          details: {},
        });
      },
    });
    const agent = new AgentLoop({
      registry,
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async () => {
        call += 1;
        return completion(script(call));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
    });
    return { agent, sends: () => sends };
  }

  it("names the tool that ran in the failure record and marks it", async () => {
    const { agent, sends } = loop((call) => (call === 1 ? sendCall : broken));
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-failed-after-send", workingDir }),
      { userMessage: "send it", maxSteps: 5, signal: new AbortController().signal },
    );
    expect(result.reason).toBe("failed");
    expect(sends()).toBe(1);
    const last = result.session.turns[result.session.turns.length - 1];
    expect(last?.kind).toBe("assistant_reply");
    if (last?.kind !== "assistant_reply") return;
    expect(last.text).toContain("this turn failed");
    expect(last.text).toContain("these tools had already run: test.send");
    expect(last.text).not.toContain("Nothing from it took effect");
    expect(last.toolsRan).toBe(true);
    expect(planLastTurnRollback(result.session)).toEqual({
      ok: false,
      code: "turn_has_tools",
    });
  });

  it("keeps the plain record when no tool ran", async () => {
    const { agent, sends } = loop(() => broken);
    const result = await agent.runTurn(
      createEmptySessionState({ id: "s-failed-no-tools", workingDir }),
      { userMessage: "go", maxSteps: 3, signal: new AbortController().signal },
    );
    expect(result.reason).toBe("failed");
    expect(sends()).toBe(0);
    const last = result.session.turns[result.session.turns.length - 1];
    expect(last?.kind).toBe("assistant_reply");
    if (last?.kind !== "assistant_reply") return;
    expect(last.text).toContain("Nothing from it took effect");
    expect(last.toolsRan).toBeUndefined();
  });
});
