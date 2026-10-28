import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../../tools/tool-registry.js";
import { SlotManager } from "../../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { ToolExecutionError } from "../../llm/index.js";
import type { CompletionResult } from "../../llm/provider/completion-types.js";
import type { ToolCallPayload } from "../../llm/grammar/tool-call-grammar.js";
import type { StepContext, StepDependencies } from "./step-contract.js";
import type { StepEvent } from "../step-events.js";
import { executeStep } from "../step-executor.js";
import { createUnknownToolStreak, UNKNOWN_TOOL_STREAK_LIMIT } from "../policies/unknown-tool.js";

function completion(calls: ToolCallPayload[]): CompletionResult {
  return {
    content: JSON.stringify(calls), reasoningContent: "", stop: true, truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
    cacheHitTokens: 0, slotId: -1, modelId: "fixture",
  };
}

function fixture(calls: ToolCallPayload[]): {
  ctx: StepContext; deps: StepDependencies; events: StepEvent[]; ran: string[];
} {
  const events: StepEvent[] = [];
  const ran: string[] = [];
  const registry = new ToolRegistry();
  for (const name of ["reply", "os.fs.read", "os.fs.grep"]) {
    registry.register({
      name, description: "fixture", readonly: true,
      run: async () => {
        ran.push(name);
        return compressToolResult({ tool: name, status: "ok", output: `${name} ok` });
      },
    });
  }
  return {
    events,
    ran,
    ctx: {
      session: createEmptySessionState({ id: "unknown-tool-fixture", workingDir: "/fixture" }),
      toolDescriptors: [], skillCatalog: [],
      capabilities: {
        platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/fixture",
        hasClipboard: false, hasWmctrl: false, hasNotifications: false,
      },
      stepIndex: 1, signal: new AbortController().signal, maxTokens: 2048,
    },
    deps: {
      registry, slotManager: new SlotManager(1),
      profile: PLAIN_INSTRUCT_PROFILE, grammar: 'root ::= "fixture"',
      toolTransport: "grammar", toolCallAdapter: null, supportsSlotAffinity: false,
      llmComplete: async () => completion(calls),
      onEvent: (event) => events.push(event),
      unknownTools: createUnknownToolStreak(),
    },
  };
}

describe("a call to a tool the registry does not hold", () => {
  it("runs the valid call of the step and answers the unknown one with an error result", async () => {
    const { ctx, deps, events, ran } = fixture([
      { tool: "os.fs.read", args: { path: "/fixture/a.txt" } },
      { tool: "os.grep", args: { pattern: "todo" } },
    ]);
    const outcome = await executeStep(ctx, deps);
    expect(ran).toEqual(["os.fs.read"]);
    expect(outcome.terminal).toBeNull();
    expect(outcome.toolCalls.map((call) => call.tool)).toEqual(["os.fs.read", "os.grep"]);
    expect(outcome.toolResults[0]).toMatchObject({ tool: "os.fs.read", status: "ok" });
    expect(outcome.toolResults[1]).toMatchObject({ tool: "os.grep", status: "error" });
    expect(outcome.toolResults[1]!.summary).toContain("Closest: os.fs.grep");
    expect(outcome.toolResults[1]!.details).toMatchObject({ unregisteredTool: true });
    // The events stay well-formed for TUI / desktop / http: one parsed
    // and one executed event per call, same batch indices and size.
    const parsed = events.filter(
      (event): event is Extract<StepEvent, { type: "tool_call_parsed" }> => event.type === "tool_call_parsed",
    );
    const executed = events.filter(
      (event): event is Extract<StepEvent, { type: "tool_call_executed" }> => event.type === "tool_call_executed",
    );
    expect(parsed.map((event) => [event.batchIndex, event.batchSize])).toEqual([[0, 2], [1, 2]]);
    expect(executed.map((event) => [event.batchIndex, event.batchSize]).sort()).toEqual([[0, 2], [1, 2]]);
    // The transcript keeps the model's order and pairs every call.
    const kinds = outcome.nextSession.turns.map((turn) => `${turn.kind}:${"tool" in turn ? turn.tool : ""}`);
    expect(kinds).toEqual([
      "assistant_tool_call:os.fs.read", "tool_result:os.fs.read",
      "assistant_tool_call:os.grep", "tool_result:os.grep",
    ]);
  });

  it("lets a solo unknown call through as an error result while under the streak limit", async () => {
    const { ctx, deps, ran } = fixture([{ tool: "os.grep", args: { pattern: "todo" } }]);
    const outcome = await executeStep(ctx, deps);
    expect(ran).toEqual([]);
    expect(outcome.toolResults).toHaveLength(1);
    expect(outcome.toolResults[0]).toMatchObject({ tool: "os.grep", status: "error" });
  });

  it("still stops on the third unknown-only step in a row, as a grouped ToolExecutionError", async () => {
    const { ctx, deps } = fixture([{ tool: "mcp.example.toolkit", args: {} }]);
    for (let i = 1; i < UNKNOWN_TOOL_STREAK_LIMIT; i += 1) {
      await executeStep({ ...ctx, stepIndex: i }, deps);
    }
    const failure = await executeStep({ ...ctx, stepIndex: UNKNOWN_TOOL_STREAK_LIMIT }, deps).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(ToolExecutionError);
    expect(failure).toMatchObject({
      category: "tool", tool: "mcp.example.toolkit", kind: "unregistered", nameClass: "mcp_like",
    });
  });

  it("resets the streak on a step with a real call", async () => {
    const unknown = fixture([{ tool: "os.grep", args: {} }]);
    const deps = unknown.deps;
    await executeStep(unknown.ctx, deps);
    await executeStep(unknown.ctx, deps);
    deps.llmComplete = async () => completion([
      { tool: "os.fs.grep", args: { pattern: "todo" } },
    ]);
    await executeStep(unknown.ctx, deps);
    deps.llmComplete = async () => completion([{ tool: "os.grep", args: {} }]);
    await expect(executeStep(unknown.ctx, deps)).resolves.toBeDefined();
  });

  it("throws at once with no streak state wired, as before", async () => {
    const { ctx, deps } = fixture([{ tool: "os.grep", args: {} }]);
    delete deps.unknownTools;
    await expect(executeStep(ctx, deps)).rejects.toMatchObject({
      name: "ToolExecutionError", kind: "unregistered", nameClass: "near_miss",
    });
  });
});
