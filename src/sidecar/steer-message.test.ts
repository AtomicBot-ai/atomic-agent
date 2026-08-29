import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";
import { resetConfigCache } from "../config/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { FakeBrowserBackend } from "../http/test-harness.js";

/**
 * Mirrors the production `steer_message` handler in
 * `src/sidecar/main.ts` — same convention as
 * `send-message-concurrency.test.ts`, which mirrors `send_message`
 * rather than driving the stdin protocol.
 *
 * The property under test is the one that makes steering different from
 * every other host request: it must NOT go through
 * `turnController.enqueue`. Enqueueing would park the message behind
 * the very turn it is meant to redirect, which is the bug this whole
 * feature exists to avoid.
 */
function makeSteerHandler(runtime: AgentRuntime, activeSessionId: string) {
  return (sessionId: string, text: string): { steered: boolean } => {
    if (activeSessionId !== sessionId) return { steered: false };
    return { steered: runtime.steer(sessionId, text) };
  };
}

describe("sidecar steer_message", () => {
  let stateDir: string;
  let workingDir: string;
  let runtime: AgentRuntime;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-sidecar-steer-state-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-sidecar-steer-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
  });

  afterEach(async () => {
    if (runtime) await runtime.shutdown();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  it("resolves immediately while a turn holds the session, and lands in that turn", async () => {
    const enters: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const llamaComplete = async (params: {
      sessionId: string;
    }): Promise<CompletionResult> => {
      if (params.sessionId.startsWith("reflection:")) return reply("ignored");
      enters.push("user-turn");
      if (enters.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return reply("done");
    };

    runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: new FakeBrowserBackend(),
        skipLlamaHealthCheck: true,
        llamaComplete,
      },
    });

    const session = runtime.createSession({ metadata: { source: "steer-test" } });
    const steer = makeSteerHandler(runtime, session.id);

    const turn = runtime.runTurn(session, "start working", {
      origin: "sidecar",
    });

    const deadline = Date.now() + 5_000;
    while (enters.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(enters).toEqual(["user-turn"]);

    // The turn is blocked inside its inference. A queued handler would
    // hang here; steering must answer now.
    expect(steer(session.id, "actually, do it differently")).toEqual({
      steered: true,
    });
    expect(runtime.steeringInbox.peek(session.id)).toEqual([
      "actually, do it differently",
    ]);

    releaseFirst?.();
    await turn;
  });

  it("refuses when the session is idle so the host falls back to send_message", async () => {
    runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: new FakeBrowserBackend(),
        skipLlamaHealthCheck: true,
        llamaComplete: async () => reply("done"),
      },
    });
    const session = runtime.createSession();
    const steer = makeSteerHandler(runtime, session.id);
    expect(steer(session.id, "hello?")).toEqual({ steered: false });
    expect(runtime.steeringInbox.peek(session.id)).toEqual([]);
  });

  it("refuses for a session that is not the active one", async () => {
    runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: new FakeBrowserBackend(),
        skipLlamaHealthCheck: true,
        llamaComplete: async () => reply("done"),
      },
    });
    const active = runtime.createSession();
    const other = runtime.createSession();
    const steer = makeSteerHandler(runtime, active.id);
    expect(steer(other.id, "wrong session")).toEqual({ steered: false });
    expect(runtime.steeringInbox.peek(other.id)).toEqual([]);
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
