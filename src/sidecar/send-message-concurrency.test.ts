import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";
import { resetConfigCache } from "../config/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { SessionPool } from "./session-pool.js";
import { FakeBrowserBackend } from "../http/test-harness.js";

/**
 * Mirrors the production `chat.send` handler in `src/sidecar/main.ts`.
 * The handler enqueues through `runtime.turnController` so that two
 * rapid NDJSON messages on the same session serialise FIFO, mints a fresh
 * abort controller per send, and re-reads the latest pooled `SessionState`
 * inside the queued callback so the second turn does not start from stale
 * state captured at enqueue time.
 */
function makeSendMessageHandler(runtime: AgentRuntime, pool: SessionPool) {
  return async (sessionId: string, text: string, maxSteps?: number) => {
    if (!pool.has(sessionId)) {
      throw new Error(`no active session with id ${sessionId}`);
    }
    const controller = pool.resetController(sessionId);
    const result = await runtime.turnController.enqueue({
      sessionId,
      origin: "sidecar",
      signal: controller.signal,
      run: async () => {
        const current = pool.get(sessionId);
        if (!current) {
          throw new Error(
            `session evicted during queued chat.send for ${sessionId}`,
          );
        }
        return runtime.executeTurn(current.session, text, {
          maxSteps: maxSteps ?? runtime.config.agent.maxSteps,
          signal: controller.signal,
        });
      },
    });
    pool.setSession(result.session);
    return result;
  };
}

describe("sidecar chat.send concurrency", () => {
  let stateDir: string;
  let workingDir: string;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-sidecar-state-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-sidecar-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.shutdown();
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  it("serialises two rapid chat.send calls FIFO without crossing state", async () => {
    const enters: string[] = [];
    const leaves: string[] = [];
    let blockFirst: (() => void) | null = null;
    let userCallCount = 0;
    const llamaComplete = async (params: {
      sessionId: string;
      grammar: string;
    }): Promise<CompletionResult> => {
      // Reflection (and its link/vote sub-calls) run on a
      // `reflection:`-prefixed session id; the recall-side query rewriter
      // rides the real session id but is identifiable by its grammar.
      // Neither is a user turn, so neither should count against FIFO order.
      if (
        params.sessionId.startsWith("reflection:") ||
        params.grammar.includes("rewritten_query")
      ) {
        return reply("ignored");
      }
      userCallCount += 1;
      const tag = `m${userCallCount}`;
      enters.push(tag);
      if (userCallCount === 1) {
        await new Promise<void>((resolve) => {
          blockFirst = resolve;
        });
      }
      leaves.push(tag);
      return reply(tag);
    };

    runtime = await createAgentRuntime({
      workingDir,
      approvalRequired: false,
      overrides: {
        browserBackend: new FakeBrowserBackend(),
        skipLlamaHealthCheck: true,
        llamaComplete,
      },
    });

    const session = runtime.createSession({ metadata: { source: "sidecar-test" } });
    const pool = new SessionPool();
    pool.register(session);
    const sendMessage = makeSendMessageHandler(runtime, pool);

    const promise1 = sendMessage(session.id, "first");
    const promise2 = sendMessage(session.id, "second");

    // Wait until the first turn enters llamaComplete.
    const deadline = Date.now() + 5_000;
    while (enters.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(enters).toEqual(["m1"]);

    // Give the second turn several event-loop turns to (incorrectly) leak
    // past the per-session controller — it must not.
    await new Promise((r) => setTimeout(r, 50));
    expect(enters).toEqual(["m1"]);

    blockFirst?.();
    const result1 = await promise1;
    const result2 = await promise2;

    // Strict order, no overlap.
    expect(enters).toEqual(["m1", "m2"]);
    expect(leaves).toEqual(["m1", "m2"]);

    // Each call sees a session that already includes its predecessor's
    // turn — proving the queued callback re-read the latest state instead
    // of operating on the snapshot captured at enqueue time.
    expect(result1.session.turnCount).toBe(1);
    expect(result2.session.turnCount).toBe(2);
    expect(pool.get(session.id)?.session.turnCount).toBe(2);
  });
});

function reply(text: string): CompletionResult {
  return {
    content: JSON.stringify({ tool: "reply", args: { text } }),
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {
      promptMs: 0,
      predictedMs: 0,
      promptTokens: 1,
      predictedTokens: 1,
    },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  };
}
