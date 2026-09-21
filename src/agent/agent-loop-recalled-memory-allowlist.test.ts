import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type {
  MemoryContext,
  MemoryContextProvider,
} from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import type { MemoryEntry } from "../memory/memory-store.js";
import type {
  ReflectionInput,
  ReflectionRunner,
} from "../memory/reflection/reflection-runner.js";

/**
 * `recalledMemoryIds` is the per-turn allowlist for the
 * link-generator sub-call (and for the EVOLVE directives inside
 * reflection). `refreshMemoryContext` runs at turn start AND after
 * every tool batch, and each run REPLACES `state.recalledNotes`, so
 * building the allowlist off the session state at reflection time
 * reads whatever the LAST recall returned — by then the query is
 * driven by tool-output summaries and usually matches nothing. The
 * net effect was an empty allowlist on every multi-step turn, i.e.
 * link generation that never fired in production.
 *
 * The loop already keeps per-turn accumulators for the two sibling
 * surfaces (`surfacedLessonIds`, `surfacedProcedureIds`) for exactly
 * this reason; this file pins the note equivalent.
 */

function makeCompletion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {
      promptMs: 1,
      predictedMs: 1,
      promptTokens: 10,
      predictedTokens: 5,
    },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

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

const SKILLS: SkillCatalogEntry[] = [];

function makeNotes(ids: readonly number[]): readonly MemoryEntry[] {
  return ids.map((id) => ({
    id,
    content: `note-${id}`,
    createdAt: 1_000,
    updatedAt: 1_000,
    source: "agent" as const,
    sessionId: null,
    workingDir: null,
    tags: [],
    recallCount: 0,
    lastRecalledAt: null,
  }));
}

/** Returns `notesByCall[i]` on the i-th refresh, then the last entry. */
function makeProvider(
  notesByCall: ReadonlyArray<readonly number[]>,
): MemoryContextProvider {
  let i = 0;
  return {
    buildMemoryContext(): MemoryContext {
      const ids = notesByCall[Math.min(i, notesByCall.length - 1)] ?? [];
      i += 1;
      return { recalled: makeNotes(ids), index: [] };
    },
  };
}

describe("AgentLoop recalledMemoryIds allowlist", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-recall-allowlist-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("survives a multi-step turn whose later recalls come back empty", async () => {
    const inputs: ReflectionInput[] = [];
    const reflectionRunner: ReflectionRunner = {
      async reflect(input) {
        inputs.push(input);
      },
      abortPending() {
        /* no-op */
      },
    };
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "ok" as const,
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        // One working step, then the reply. The tool result triggers
        // the post-batch `refreshMemoryContext`, which is where the
        // recall goes quiet.
        return makeCompletion(
          calls === 1
            ? JSON.stringify({ tool: "noop", args: {} })
            : JSON.stringify({ tool: "reply", args: { text: "done" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      // Turn-start recall surfaces two notes; every later refresh
      // matches nothing, which is the production shape.
      memoryContextProvider: makeProvider([[11, 12], []]),
      reflectionRunner,
    });

    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-multi", workingDir }),
      {
        userMessage: "do the thing",
        maxSteps: 4,
        signal: new AbortController().signal,
      },
    );

    expect(result.reason).toBe("reply");
    expect(inputs).toHaveLength(1);
    // On main this is `undefined`: the last refresh wiped
    // `state.recalledNotes` before reflection read it.
    expect([...(inputs[0]!.recalledMemoryIds ?? [])].sort()).toEqual([11, 12]);
  });

  it("unions notes surfaced across steps, without duplicates", async () => {
    const inputs: ReflectionInput[] = [];
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "ok" as const,
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        return makeCompletion(
          calls <= 2
            ? JSON.stringify({ tool: "noop", args: {} })
            : JSON.stringify({ tool: "reply", args: { text: "done" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      memoryContextProvider: makeProvider([
        [11, 12],
        [12, 13],
        [],
      ]),
      reflectionRunner: {
        async reflect(input) {
          inputs.push(input);
        },
        abortPending() {
          /* no-op */
        },
      },
    });

    await loop.runTurn(
      createEmptySessionState({ id: "s-union", workingDir }),
      {
        userMessage: "do the thing",
        maxSteps: 6,
        signal: new AbortController().signal,
      },
    );

    expect(inputs).toHaveLength(1);
    const ids = [...(inputs[0]!.recalledMemoryIds ?? [])];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([11, 12, 13]);
  });

  it("stays undefined when no note ever surfaced", async () => {
    const inputs: ReflectionInput[] = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(JSON.stringify({ tool: "reply", args: { text: "ok" } })),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      memoryContextProvider: makeProvider([[]]),
      reflectionRunner: {
        async reflect(input) {
          inputs.push(input);
        },
        abortPending() {
          /* no-op */
        },
      },
    });

    await loop.runTurn(
      createEmptySessionState({ id: "s-none", workingDir }),
      {
        userMessage: "hi",
        maxSteps: 2,
        signal: new AbortController().signal,
      },
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.recalledMemoryIds).toBeUndefined();
  });
});
