import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { AgentLoopEvent } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { CapabilitiesSummary, ToolDescriptor } from "../prompt/stable-prefix.js";
import type { ConversationTurn } from "../session/conversation-turn.js";

type ToolResultTurn = Extract<ConversationTurn, { kind: "tool_result" }>;
const isToolResult = (turn: ConversationTurn): turn is ToolResultTurn =>
  turn.kind === "tool_result";

/**
 * ATO-1029: a model that calls a tool name the agent does not have
 * (`os.grep` for `os.fs.grep`) is told so and corrects itself, instead
 * of the whole turn failing on the guess.
 */

function completion(calls: unknown[]): CompletionResult {
  return {
    content: JSON.stringify(calls),
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
  { name: "os.fs.read", summary: "Read a file.", argsSchema: '{"path": string}' },
  { name: "os.fs.grep", summary: "Search files.", argsSchema: '{"pattern": string}' },
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

describe("AgentLoop with an unregistered tool name", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-unknown-tool-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function loop(script: (call: number) => unknown[]) {
    const prompts: string[] = [];
    const ran: string[] = [];
    const events: AgentLoopEvent[] = [];
    let call = 0;
    const registry = buildDefaultToolRegistry();
    for (const name of ["os.fs.read", "os.fs.grep"]) {
      registry.register({
        name,
        description: name,
        readonly: true,
        run: async () => {
          ran.push(name);
          return compressToolResult({ tool: name, status: "ok", output: `${name} found it` });
        },
      });
    }
    const agent = new AgentLoop({
      registry,
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async (params) => {
        prompts.push(params.prompt);
        call += 1;
        return completion(script(call));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      onEvent: (event) => events.push(event),
    });
    return { agent, prompts, ran, events, calls: () => call };
  }

  const run = (agent: AgentLoop, id: string) =>
    agent.runTurn(createEmptySessionState({ id, workingDir }), {
      userMessage: "find the todo",
      maxSteps: 8,
      taskMaxSteps: 8,
      signal: new AbortController().signal,
    });

  it("answers `os.grep` with the closest tool and lets the turn finish", async () => {
    const { agent, prompts, ran } = loop((call) =>
      call === 1
        ? [{ tool: "os.grep", args: { pattern: "todo" } }]
        : call === 2
          ? [{ tool: "os.fs.grep", args: { pattern: "todo" } }]
          : [{ tool: "reply", args: { text: "found it" } }],
    );
    const result = await run(agent, "s-near-miss");
    expect(result.reason).toBe("reply");
    expect(ran).toEqual(["os.fs.grep"]);
    expect(prompts.some((prompt) => prompt.includes("Closest: os.fs.grep"))).toBe(true);
    const refused = result.session.turns
      .filter(isToolResult)
      .find((turn) => turn.tool === "os.grep");
    expect(refused).toMatchObject({ status: "error" });
  });

  it("runs the valid call of a step that also names an unknown tool", async () => {
    const { agent, ran } = loop((call) =>
      call === 1
        ? [
            { tool: "os.fs.read", args: { path: "notes.txt" } },
            { tool: "os.browser.navigate", args: { url: "https://example.com" } },
          ]
        : [{ tool: "reply", args: { text: "done" } }],
    );
    const result = await run(agent, "s-mixed");
    expect(result.reason).toBe("reply");
    expect(ran).toEqual(["os.fs.read"]);
    const results = result.session.turns.filter(isToolResult);
    expect(results.map((turn) => [turn.tool, turn.status])).toEqual([
      ["os.fs.read", "ok"],
      ["os.browser.navigate", "error"],
    ]);
  });

  it("still fails a turn that calls only unknown tools three steps in a row", async () => {
    const { agent, events, calls } = loop(() => [{ tool: "function_name", args: {} }]);
    const result = await run(agent, "s-streak");
    expect(result.reason).toBe("failed");
    expect(calls()).toBe(3);
    const stepErrors = events.flatMap((event) =>
      event.type === "llm_event" && event.event.type === "step_error" ? [event.event] : [],
    );
    expect(stepErrors).toHaveLength(1);
    expect(stepErrors[0]).toMatchObject({ category: "tool" });
    expect(stepErrors[0]!.error).toMatchObject({ kind: "unregistered", nameClass: "other" });
  });
});
