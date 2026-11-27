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
import type { CliOutdatedEvent } from "./cli-outdated-notice.js";

/**
 * ATO-2523, loop wiring. A completion marked `cliOutdated` (the Claude
 * Code / Codex CLI that answered is older than we support) becomes one
 * `cli_outdated` event per session, however many completions and turns
 * carry the mark.
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
const OUTDATED = {
  cli: "claude" as const,
  productName: "Claude Code",
  version: "2.1.0",
  minimum: "2.1.22",
  updateCommands: ["claude update"],
};
const completion = (content: string, marked = true): CompletionResult => ({
  content,
  reasoningContent: "",
  stop: true,
  truncated: false,
  cacheHitTokens: 0,
  slotId: 0,
  modelId: "mock",
  timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
  ...(marked ? { cliOutdated: OUTDATED } : {}),
});
const REPLY = JSON.stringify({ tool: "reply", args: { text: "ok" } });

describe("AgentLoop says when the subscription CLI is outdated", () => {
  let workingDir: string;
  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cli-outdated-"));
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
  const outdated = (events: AgentLoopEvent[]): CliOutdatedEvent[] =>
    events.filter((e): e is CliOutdatedEvent => e.type === "cli_outdated");
  const turn = (loop: AgentLoop, id: string) =>
    loop.runTurn(createEmptySessionState({ id, workingDir }), {
      userMessage: "hello",
      maxSteps: 3,
      signal: new AbortController().signal,
    });

  it("says it once per session, across completions and turns", async () => {
    const events: AgentLoopEvent[] = [];
    const replies = [completion("{{garbage"), completion(REPLY)];
    const loop = makeLoop(events, () => replies.shift() ?? completion(REPLY));

    await turn(loop, "s1");
    await turn(loop, "s1");

    expect(outdated(events)).toEqual([{ type: "cli_outdated", stepIndex: 0, ...OUTDATED }]);
  });

  it("says it again in another session", async () => {
    const events: AgentLoopEvent[] = [];
    const loop = makeLoop(events, () => completion(REPLY));

    await turn(loop, "s2");
    await turn(loop, "s3");

    expect(outdated(events)).toHaveLength(2);
  });

  it("comes right after the completion that carried it, before any tool runs", async () => {
    const events: AgentLoopEvent[] = [];
    const loop = makeLoop(events, () => completion(REPLY));

    await turn(loop, "s4");

    const at = events.findIndex((e) => e.type === "cli_outdated");
    expect(at).toBeGreaterThan(0);
    const before = events[at - 1];
    expect(before?.type === "llm_event" && before.event.type === "llm_completed").toBe(true);
    const firstTool = events.findIndex((e) => e.type === "llm_event" && e.event.type === "tool_call_executed");
    if (firstTool >= 0) expect(firstTool).toBeGreaterThan(at);
  });

  it("says nothing for a CLI new enough", async () => {
    const events: AgentLoopEvent[] = [];
    const loop = makeLoop(events, () => completion(REPLY, false));

    await turn(loop, "s5");

    expect(outdated(events)).toEqual([]);
  });
});
