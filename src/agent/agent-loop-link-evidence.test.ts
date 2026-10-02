import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { LlmStreamParams } from "./step-executor.js";
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
 * #581 through the loop: a reply whose link no tool result holds is held
 * once per turn, the second is delivered, and the next turn starts with
 * a fresh notice flag.
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

const RESULT_URL = "https://example.com/guides/install-the-agent";
const SEARCH = JSON.stringify([{ tool: "os.shell.run", args: { cmd: "search" } }]);
const reply = (text: string) => JSON.stringify([{ tool: "reply", args: { text } }]);

const TOOLS: ToolDescriptor[] = [
  { name: "reply", summary: "Reply to the user.", argsSchema: '{"text": string}' },
  { name: "finish", summary: "Finish the session.", argsSchema: '{"summary": string}' },
  { name: "os.shell.run", summary: "Run a command.", argsSchema: '{"cmd": string}' },
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

describe("AgentLoop: links need a source (#581)", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-link-evidence-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("holds once per turn and resets the notice for the next turn", async () => {
    const script = [
      SEARCH,
      reply("Guide: https://example.com/guides/install-agent"),
      reply("Guide: https://example.com/guides/install-agent"),
      SEARCH,
      reply("Guide: https://example.com/guides/the-agent"),
      reply(`Guide: ${RESULT_URL}`),
    ];
    const prompts: string[] = [];
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "os.shell.run",
      description: "Run a command.",
      readonly: false,
      run: async () =>
        compressToolResult({
          tool: "os.shell.run",
          status: "ok",
          output: `1. Install the agent\n   ${RESULT_URL}`,
        }),
    });
    const agent = new AgentLoop({
      registry,
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async (params: LlmStreamParams) => {
        prompts.push(params.prompt);
        return completion(script[prompts.length - 1]!);
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
    });
    const signal = new AbortController().signal;
    const first = await agent.runTurn(
      createEmptySessionState({ id: "s-581", workingDir }),
      { userMessage: "find the install guide", maxSteps: 5, signal },
    );
    expect(first.reason).toBe("reply");
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain(
      'Your reply links "https://example.com/guides/install-agent"',
    );
    // Held once, then delivered as written.
    expect(first.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "Guide: https://example.com/guides/install-agent",
    });

    const second = await agent.runTurn(first.session, {
      userMessage: "and the other one?",
      maxSteps: 5,
      signal,
    });
    expect(second.reason).toBe("reply");
    expect(prompts).toHaveLength(6);
    // A fresh turn: the notice fires again for a new unsourced link.
    expect(prompts[5]).toContain(
      'Your reply links "https://example.com/guides/the-agent"',
    );
    expect(second.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: `Guide: ${RESULT_URL}`,
    });
  });
});
