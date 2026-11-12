import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";
import { SlotManager } from "../llm/slot-manager.js";
import type {
  CapabilitiesSummary,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import { createEmptySessionState } from "../session/session-state.js";
import { buildDefaultToolRegistry } from "../tools/index.js";

import { AgentLoop } from "./agent-loop.js";
import type { AgentLoopEvent, MemoryContextProvider } from "./agent-loop.js";
import type { ToolDisabledEvent } from "./tool-disabled-notice.js";

/**
 * ATO-1417, loop wiring. A completion whose request went out without a
 * tool (`droppedTools`, the server refused its schema) becomes one
 * `tool_disabled` event per tool per turn, however many completions of
 * the turn report it.
 */

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
const NOOP_PROVIDER: MemoryContextProvider = {
  buildMemoryContext: () => ({ recalled: [], index: [] }),
};
const DROPPED = [
  { name: "notion.search", reason: "schema_rejected" as const },
];
const completion = (content: string, dropped = true): CompletionResult => ({
  content,
  reasoningContent: "",
  stop: true,
  truncated: false,
  cacheHitTokens: 0,
  slotId: 0,
  modelId: "mock",
  timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
  ...(dropped ? { droppedTools: DROPPED } : {}),
});
const REPLY = JSON.stringify({ tool: "reply", args: { text: "ok" } });

describe("AgentLoop says when a tool was left out of the request", () => {
  let workingDir: string;
  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-tool-disabled-"));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const makeLoop = (
    events: AgentLoopEvent[],
    complete: () => CompletionResult,
  ): AgentLoop =>
    new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => complete(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      memoryContextProvider: NOOP_PROVIDER,
      onEvent: (event) => events.push(event),
    });
  const disabled = (events: AgentLoopEvent[]): ToolDisabledEvent[] =>
    events.filter((e): e is ToolDisabledEvent => e.type === "tool_disabled");
  const completions = (events: AgentLoopEvent[]): number =>
    events.filter(
      (e) => e.type === "llm_event" && e.event.type === "llm_completed",
    ).length;
  const turn = (loop: AgentLoop, id: string) =>
    loop.runTurn(createEmptySessionState({ id, workingDir }), {
      userMessage: "hello",
      maxSteps: 3,
      signal: new AbortController().signal,
    });

  it("names the tool once, however many completions of the turn drop it", async () => {
    const events: AgentLoopEvent[] = [];
    // An unparseable first completion makes the turn ask again: two
    // completions in one turn, both sent without the same tool.
    const replies = [completion("{{garbage"), completion(REPLY)];
    const loop = makeLoop(events, () => replies.shift() ?? completion(REPLY));

    await turn(loop, "s1");

    expect(completions(events)).toBeGreaterThanOrEqual(2);
    expect(disabled(events)).toEqual([
      {
        type: "tool_disabled",
        stepIndex: 0,
        tool: "notion.search",
        reason: "schema_rejected",
      },
    ]);
  });

  it("names it again on the next turn", async () => {
    const events: AgentLoopEvent[] = [];
    const loop = makeLoop(events, () => completion(REPLY));

    await turn(loop, "s2");
    await turn(loop, "s2");

    expect(disabled(events)).toHaveLength(2);
  });

  it("says nothing when every tool went out", async () => {
    const events: AgentLoopEvent[] = [];
    const loop = makeLoop(events, () => completion(REPLY, false));

    await turn(loop, "s3");

    expect(completions(events)).toBeGreaterThan(0);
    expect(disabled(events)).toEqual([]);
  });
});
