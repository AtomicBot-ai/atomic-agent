import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";
import { SlotManager } from "../llm/slot-manager.js";
import type { ProfileFact } from "../memory/profile-store.js";
import type { ProfileClipStats } from "../prompt/clip-profile-section.js";
import type {
  CapabilitiesSummary,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import { createEmptySessionState } from "../session/session-state.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

import { AgentLoop } from "./agent-loop.js";
import type { AgentLoopEvent, MemoryContextProvider } from "./agent-loop.js";
import type { ProfileClippedEvent } from "./profile-clip-warning.js";

/**
 * Issue #407, loop wiring. Every step's `prompt_built` carries the
 * clip; `AgentLoop` must turn it into one `profile_clipped` event (and
 * one warn log) per session, not one per turn.
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
const REPLY: CompletionResult = {
  content: JSON.stringify({ tool: "reply", args: { text: "ok" } }),
  reasoningContent: "",
  stop: true,
  truncated: false,
  cacheHitTokens: 0,
  slotId: 0,
  modelId: "mock",
};

function profileFacts(
  count: number,
  prefix: string,
  shape: { pinned: boolean; value: string; keywords?: string[] },
): ProfileFact[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    key: `${prefix}_${String(i).padStart(3, "0")}`,
    value: `${shape.value} ${i}`,
    validFrom: 1,
    updatedAt: 1,
    pinned: shape.pinned,
    keywords: shape.keywords ?? [],
    supersedes: null,
    supersededBy: null,
    voteScore: 0,
  }));
}
// 80 of these are well past the default 512-token budget.
const pinnedFacts = (count: number, prefix: string): ProfileFact[] =>
  profileFacts(count, prefix, {
    pinned: true,
    value: "a pinned value that is long enough to matter, number",
  });

function warnCounter(): { logger: StructuredLogger; count: () => number } {
  let warned = 0;
  const noop = (): void => {};
  const logger = {
    debug: noop,
    info: noop,
    error: noop,
    warn(message: string) {
      if (message.includes("profile section clipped")) warned += 1;
    },
  } as unknown as StructuredLogger;
  return { logger, count: () => warned };
}

describe("AgentLoop reports a clipped profile", () => {
  let workingDir: string;
  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-profile-clip-"));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const makeLoop = (
    events: AgentLoopEvent[],
    facts: () => readonly ProfileFact[],
    logger: StructuredLogger,
  ): AgentLoop =>
    new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => REPLY,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      memoryContextProvider: NOOP_PROVIDER,
      profileFactsProvider: facts,
      logger,
      onEvent: (event) => events.push(event),
    });
  const clipped = (events: AgentLoopEvent[]): ProfileClippedEvent[] =>
    events.filter((e): e is ProfileClippedEvent => e.type === "profile_clipped");
  const builtClips = (events: AgentLoopEvent[]): ProfileClipStats[] =>
    events.flatMap((e) =>
      e.type === "llm_event" &&
      e.event.type === "prompt_built" &&
      e.event.prompt.profileClip !== undefined
        ? [e.event.prompt.profileClip]
        : [],
    );
  const runTurns = async (
    loop: AgentLoop,
    id: string,
    messages: readonly string[],
  ): Promise<void> => {
    let session = createEmptySessionState({ id, workingDir });
    for (const userMessage of messages) {
      const signal = new AbortController().signal;
      const result = await loop.runTurn(session, {
        userMessage,
        maxSteps: 2,
        signal,
      });
      session = result.session;
    }
  };

  it("once across turns, and again when more pinned facts are left out", async () => {
    const warn = warnCounter();
    const events: AgentLoopEvent[] = [];
    let facts = pinnedFacts(80, "fact");
    const loop = makeLoop(events, () => facts, warn.logger);

    await runTurns(loop, "clip-1", ["hello", "hello", "hello"]);
    expect(builtClips(events)).toHaveLength(3);
    expect(clipped(events)).toHaveLength(1);
    const first = clipped(events)[0]!;
    expect(first.dropped).toBeGreaterThan(0);
    expect(first.pinnedDropped).toBe(first.dropped);
    expect(warn.count()).toBe(1);

    facts = [...facts, ...pinnedFacts(5, "zz_more")];
    await runTurns(loop, "clip-1", ["hello"]);
    expect(clipped(events)).toHaveLength(2);
    expect(clipped(events)[1]!.pinnedDropped).toBe(first.pinnedDropped + 5);
    expect(warn.count()).toBe(2);
  });

  it("not again when keyword-gated facts come and go with the message", async () => {
    const warn = warnCounter();
    const events: AgentLoopEvent[] = [];
    const facts = [
      ...pinnedFacts(80, "fact"),
      ...profileFacts(3, "ctx", {
        pinned: false,
        value: "y".repeat(300),
        keywords: ["deploy"],
      }),
    ];
    const loop = makeLoop(events, () => facts, warn.logger);

    await runTurns(loop, "clip-2", ["hello", "deploy now", "hello", "deploy"]);

    // The total really did move from turn to turn...
    expect(new Set(builtClips(events).map((c) => c.dropped)).size).toBe(2);
    // ...and the operator heard about it once.
    expect(clipped(events)).toHaveLength(1);
    expect(warn.count()).toBe(1);
  });

  it("not for an ephemeral fusion-worker turn", async () => {
    const warn = warnCounter();
    const events: AgentLoopEvent[] = [];
    const facts = pinnedFacts(80, "fact");
    const loop = makeLoop(events, () => facts, warn.logger);

    await loop.runTurn(createEmptySessionState({ id: "worker", workingDir }), {
      userMessage: "hello",
      maxSteps: 2,
      signal: new AbortController().signal,
      ephemeral: true,
    });

    // The clip happened — the warning is what was skipped.
    expect(builtClips(events).length).toBeGreaterThan(0);
    expect(clipped(events)).toEqual([]);
    expect(warn.count()).toBe(0);
  });
});
