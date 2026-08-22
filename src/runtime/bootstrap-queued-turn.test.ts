import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "./bootstrap.js";
import { resetConfigCache } from "../config/index.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import type { CompletionResult } from "../llm/llama-server-client.js";

/**
 * The stale-SessionState lost update (§"Concurrency contract": never
 * hold a stale `SessionState` between enqueue and run).
 *
 * `runTurn` is `enqueue({ run: () => executeTurn(session, …) })`. A
 * caller that captured `session` while a turn from another origin was
 * still running — the TUI switching into a foreign-busy thread is the
 * case in point — used to run the queued turn on that pre-switch
 * snapshot once the lock freed. Both turns then saved sessions built
 * from the same ancestor, and whichever finished last clobbered the
 * other's transcript. The fix re-reads the latest stored session inside
 * the queued callback, at run() time.
 */

/** The browser tools are registered but never invoked by these turns. */
function inertBackend(): BrowserBackend {
  return {
    ensureReady: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as BrowserBackend;
}

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

function userTexts(turns: readonly { kind: string }[]): string[] {
  return turns
    .filter((t) => t.kind === "user")
    .map((t) => (t as { text: string }).text);
}

describe("runTurn queued behind a foreign turn", () => {
  let stateDir: string;
  let workingDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-queued-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cwd-queued-"));
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

  it("re-reads the stored session at run() time instead of the enqueue-time snapshot", async () => {
    let inferences = 0;
    let releaseForeignTurn!: () => void;
    const foreignTurnGate = new Promise<void>((resolve) => {
      releaseForeignTurn = resolve;
    });
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: inertBackend(),
        skipLlamaHealthCheck: true,
        llamaComplete: async () => {
          inferences += 1;
          // Inference 1 belongs to the foreign turn (it owns the lock
          // first); holding it open is what keeps that turn running
          // while the second caller enqueues with its stale snapshot.
          if (inferences === 1) await foreignTurnGate;
          return completion(
            JSON.stringify({ tool: "reply", args: { text: `reply ${inferences}` } }),
          );
        },
      },
    });
    try {
      const session = runtime.createSession();
      // The snapshot a host holds across the enqueue — captured before
      // the foreign turn below writes its result to the store.
      const staleSnapshot = session;

      const foreign = runtime.runTurn(session, "foreign work", {
        origin: "scheduler",
        maxSteps: 4,
      });
      // Parked FIFO behind the foreign turn, snapshot captured NOW.
      const queued = runtime.runTurn(staleSnapshot, "operator message", {
        origin: "tui",
        maxSteps: 4,
      });
      releaseForeignTurn();
      const [foreignResult, queuedResult] = await Promise.all([
        foreign,
        queued,
      ]);
      expect(foreignResult.reason).toBe("reply");
      expect(queuedResult.reason).toBe("reply");

      // The queued turn ran on top of the foreign turn's save…
      expect(userTexts(queuedResult.session.turns)).toEqual([
        "foreign work",
        "operator message",
      ]);
      // …and the store holds BOTH conversations, not the last writer's.
      const stored = runtime.sessionStore.load(session.id);
      expect(stored).not.toBeNull();
      expect(userTexts(stored?.turns ?? [])).toEqual([
        "foreign work",
        "operator message",
      ]);
    } finally {
      await runtime.shutdown();
    }
  });
});
