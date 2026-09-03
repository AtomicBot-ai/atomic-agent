import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { MemoryContextProvider } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import type { ProfileFact } from "../memory/profile-store.js";
import type {
  ReflectionInput,
  ReflectionRunner,
} from "../memory/reflection/reflection-runner.js";

/**
 * `runTurn` fires reflection as a bare `void` — it is background
 * bookkeeping the user is not waiting on. Two ways that used to hurt
 * the turn:
 *
 *   - a decorator that reads a store closed by shutdown rejects, and
 *     with nothing attached to the promise the process reports an
 *     unhandled rejection (`error-reporting/error-reporter.ts`
 *     forwards those to the crash reporter);
 *   - `profileFactsProvider` is a raw `profileStore.list()` evaluated
 *     synchronously to build the reflection allowlist, so a store
 *     failure there failed the *turn*.
 *
 * Neither is recoverable by the loop and neither should be visible to
 * the user, so both are pinned here.
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

const NOOP_PROVIDER: MemoryContextProvider = {
  buildMemoryContext: () => ({ recalled: [], index: [] }),
};

function makeFact(id: number): ProfileFact {
  return {
    id,
    key: "editor",
    value: "vim",
    validFrom: 1,
    updatedAt: 1,
    pinned: true,
    keywords: [],
    supersedes: null,
    supersededBy: null,
    voteScore: 0,
  };
}

function makeLoop(deps: {
  reflectionRunner: ReflectionRunner;
  profileFactsProvider?: () => readonly ProfileFact[];
}): AgentLoop {
  return new AgentLoop({
    registry: buildDefaultToolRegistry(),
    slotManager: new SlotManager(2),
    grammar: 'root ::= "ok"',
    llmComplete: async () =>
      makeCompletion(JSON.stringify({ tool: "reply", args: { text: "ok" } })),
    toolDescriptors: TOOLS,
    capabilities: CAPS,
    skillCatalog: SKILLS,
    memoryContextProvider: NOOP_PROVIDER,
    reflectionRunner: deps.reflectionRunner,
    ...(deps.profileFactsProvider
      ? { profileFactsProvider: deps.profileFactsProvider }
      : {}),
  });
}

/** Collect unhandled rejections raised while `body` runs. */
async function withUnhandledRejectionWatch(
  body: () => Promise<void>,
): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  // Vitest installs its own handler; prepend so ours observes first
  // and keep the runner's in place.
  process.prependListener("unhandledRejection", onRejection);
  try {
    await body();
    // An unhandled rejection is reported after the microtask queue
    // drains — give the loop's `void` promise two macrotask ticks.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.removeListener("unhandledRejection", onRejection);
  }
  return seen;
}

describe("AgentLoop reflection is background work, never a turn hazard", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-reflect-loop-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("a rejecting reflectionRunner raises no unhandled rejection", async () => {
    let called = false;
    const loop = makeLoop({
      reflectionRunner: {
        async reflect(_input: ReflectionInput) {
          called = true;
          throw new TypeError("The database connection is not open");
        },
        abortPending() {
          /* no-op */
        },
      },
    });
    const session = createEmptySessionState({ id: "s1", workingDir });

    const seen = await withUnhandledRejectionWatch(async () => {
      const result = await loop.runTurn(session, {
        userMessage: "hello",
        maxSteps: 2,
        signal: new AbortController().signal,
      });
      expect(result.session.id).toBe("s1");
    });

    expect(called).toBe(true);
    expect(seen).toEqual([]);
  });

  it("a throwing profileFactsProvider does not fail the turn", async () => {
    const inputs: ReflectionInput[] = [];
    const loop = makeLoop({
      reflectionRunner: {
        async reflect(input: ReflectionInput) {
          inputs.push(input);
        },
        abortPending() {
          /* no-op */
        },
      },
      profileFactsProvider: () => {
        throw new TypeError("The database connection is not open");
      },
    });
    const session = createEmptySessionState({ id: "s2", workingDir });

    const result = await loop.runTurn(session, {
      userMessage: "hello",
      maxSteps: 2,
      signal: new AbortController().signal,
    });

    expect(result.session.id).toBe("s2");
    // Reflection still fires — just without profile candidates.
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.recalledProfileFactIds).toBeUndefined();
  });

  it("a healthy profileFactsProvider still supplies the allowlist", async () => {
    const inputs: ReflectionInput[] = [];
    const loop = makeLoop({
      reflectionRunner: {
        async reflect(input: ReflectionInput) {
          inputs.push(input);
        },
        abortPending() {
          /* no-op */
        },
      },
      profileFactsProvider: () => [makeFact(7)],
    });
    const session = createEmptySessionState({ id: "s3", workingDir });

    await loop.runTurn(session, {
      userMessage: "hello",
      maxSteps: 2,
      signal: new AbortController().signal,
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.recalledProfileFactIds).toEqual([7]);
  });
});
