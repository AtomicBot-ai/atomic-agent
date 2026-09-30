import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/index.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import type { TraceEvent } from "../tracing/index.js";

import { createAgentRuntime } from "./bootstrap.js";

/**
 * The wiring end of the vote trace. `createVoteTraceSink` is unit
 * tested in `announce-memory-health.test.ts`, but a sink nobody passes
 * is the same silence the row exists to kill: dropping `emitTrace` from
 * either `createVoteRunner` or `createVoteAwareReflectionRunner` in
 * bootstrap disconnects voting from the trace with `tsc` clean and
 * every other test green. So this goes through the real runtime, the
 * real decorator and the real per-session recorder, and asserts the row
 * reaches a trace sink.
 */

function inertBackend(): BrowserBackend {
  return {
    ensureReady: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as BrowserBackend;
}

function completion(content: string, slotId = 0): CompletionResult {
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
    slotId,
    modelId: "mock",
  };
}

/**
 * First surfaced memory id in a vote prompt's own SURFACED block — the
 * LAST one in the prompt, because `VOTE_STABLE_PREFIX` spells out two
 * worked examples with `SURFACED:` blocks of their own.
 */
function firstSurfacedMemoryId(prompt: string): number | null {
  const blocks = prompt.split("SURFACED:");
  const hit = /^memory:(\d+)/m.exec(blocks[blocks.length - 1] ?? "");
  return hit ? Number(hit[1]) : null;
}

describe("vote trace through bootstrap", () => {
  let stateDir: string;
  let workingDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-votetrace-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cwd-votetrace-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  it("writes the decorator's run row and the runner's per-vote rows to the session trace", async () => {
    const traceRows: TraceEvent[] = [];
    const votePrompts: string[] = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      traceDefault: true,
      handlers: {
        traceSinks: [(row) => traceRows.push(row)],
      },
      overrides: {
        browserBackend: inertBackend(),
        skipLlamaHealthCheck: true,
        llamaComplete: async (params) => {
          if (params.sessionId.startsWith("vote:")) {
            votePrompts.push(params.prompt);
            const id = firstSurfacedMemoryId(params.prompt);
            return completion(
              id === null ? "NONE\n" : `UPVOTE memory:${id}\n`,
              params.slotId,
            );
          }
          if (params.sessionId.startsWith("reflection:")) {
            return completion(
              "NOTE the marmalade deploy command for this project is `make dev`\n",
              params.slotId,
            );
          }
          // Other sub-calls (rewriter, link-gen) pin slot -1.
          if (params.slotId === -1) {
            return completion("<rewritten_query>NONE</rewritten_query>\n", -1);
          }
          return completion(
            JSON.stringify({ tool: "reply", args: { text: "noted" } }),
          );
        },
      },
    });
    const rowsFor = (sessionId: string, type: string): TraceEvent[] =>
      traceRows.filter((r) => r.sessionId === sessionId && r.type === type);
    try {
      let session = runtime.createSession();
      const sessionId = session.id;

      // Turn 1 recalls nothing, so the decorator bails out before the
      // runner: the only row that can report this turn is its own.
      const first = await runtime.runTurn(
        session,
        "remember the marmalade deploy command",
        { maxSteps: 3 },
      );
      expect(first.reason).toBe("reply");
      session = first.session;
      await vi.waitFor(
        () => expect(rowsFor(sessionId, "vote")).toHaveLength(1),
        { timeout: 10_000 },
      );
      expect(rowsFor(sessionId, "vote")[0]).toMatchObject({
        type: "vote",
        outcome: "skipped",
        candidates: 0,
      });

      // Turn 2 recalls the note turn 1 stored, so the runner runs and
      // its per-vote row is the one that narrates the turn.
      const second = await runtime.runTurn(
        session,
        "what is the marmalade deploy command?",
        { maxSteps: 3 },
      );
      expect(second.reason).toBe("reply");
      await vi.waitFor(
        () => expect(rowsFor(sessionId, "vote_applied")).toHaveLength(1),
        { timeout: 10_000 },
      );
      // Not vacuous: the runner really was reached with a candidate.
      expect(votePrompts.map(firstSurfacedMemoryId)).not.toContain(null);
      // And the decorator did not double-report the turn the runner
      // narrated vote by vote.
      expect(rowsFor(sessionId, "vote")).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  }, 60_000);
});
