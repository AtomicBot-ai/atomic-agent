import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";
import { resetConfigCache } from "../config/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { SessionState } from "../session/index.js";
import { FakeBrowserBackend } from "../http/test-harness.js";
import { TurnCancelScope } from "./turn-cancel-scope.js";

/**
 * ATO-1645: after one `cancel` every later turn of the session ended as
 * cancelled at once, because the session's only AbortController stayed
 * aborted.
 */
describe("TurnCancelScope", () => {
  it("cancel aborts the signal a turn took", () => {
    const scope = new TurnCancelScope();
    const taken = scope.signal;
    scope.cancel();
    expect(taken.aborted).toBe(true);
  });

  it("arms a fresh signal after cancel, so the next turn can run", () => {
    const scope = new TurnCancelScope();
    const first = scope.signal;
    scope.cancel();
    const next = scope.signal;
    expect(next).not.toBe(first);
    expect(next.aborted).toBe(false);
  });

  it("a second cancel stops the next turn too", () => {
    const scope = new TurnCancelScope();
    scope.cancel();
    const second = scope.signal;
    scope.cancel();
    expect(second.aborted).toBe(true);
    expect(scope.signal.aborted).toBe(false);
  });

  it("an abort listener already sees the fresh signal", () => {
    const scope = new TurnCancelScope();
    let seen: boolean | undefined;
    scope.signal.addEventListener("abort", () => {
      seen = scope.signal.aborted;
    });
    scope.cancel();
    expect(seen).toBe(false);
  });

  it("dispose aborts without arming a new signal", () => {
    const scope = new TurnCancelScope();
    const taken = scope.signal;
    scope.dispose();
    expect(taken.aborted).toBe(true);
    expect(scope.signal).toBe(taken);
  });
});

/**
 * Mirrors the production `send_message` / `cancel` / `steer_message`
 * handlers in `src/sidecar/main.ts` (same convention as
 * `send-message-concurrency.test.ts`): the signal is read once at
 * request entry and handed to both `turnController.enqueue` and
 * `executeTurn`.
 */
function sidecarHandlers(
  runtime: AgentRuntime,
  active: { session: SessionState },
  scope: TurnCancelScope,
) {
  return {
    send: async (text: string) => {
      const sessionId = active.session.id;
      const signal = scope.signal;
      const result = await runtime.turnController.enqueue({
        sessionId,
        origin: "sidecar",
        signal,
        run: async () => {
          const latest = runtime.sessionStore.load(sessionId) ?? active.session;
          return runtime.executeTurn(latest, text, {
            signal,
            origin: "sidecar",
          });
        },
      });
      active.session = result.session;
      return result;
    },
    cancel: () => scope.cancel(),
    steer: (text: string) => runtime.steer(active.session.id, text),
  };
}

describe("sidecar cancel, then run (ATO-1645)", () => {
  let stateDir: string;
  let workingDir: string;
  let runtime: AgentRuntime | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-sidecar-cancel-state-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-sidecar-cancel-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
  });

  afterEach(async () => {
    if (runtime) await runtime.shutdown();
    runtime = undefined;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  it("cancel still aborts the running turn, and the next message in the same session runs", async () => {
    // Each user inference waits at a gate the test opens. The first one
    // then fails the way a torn-down request does, after the cancel.
    const gates: Array<() => void> = [];
    let userCalls = 0;
    const llamaComplete = async (params: {
      sessionId: string;
    }): Promise<CompletionResult> => {
      if (/^(reflection|title|rewriter):/.test(params.sessionId)) {
        return reply("ignored");
      }
      userCalls += 1;
      const call = userCalls;
      await new Promise<void>((resolve) => gates.push(resolve));
      if (call === 1) throw new Error("request aborted");
      return reply(`answer ${call}`);
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
    const active = { session: runtime.createSession() };
    const scope = new TurnCancelScope();
    const host = sidecarHandlers(runtime, active, scope);

    const first = host.send("long task");
    await waitFor(() => gates.length === 1);
    host.cancel();
    gates[0]?.();
    const stopped = await first;
    expect(stopped.reason).toBe("cancelled");

    // Before the fix this rejected at once: the signal was still aborted.
    const second = host.send("try again");
    await waitFor(() => gates.length === 2);
    // Steering still reaches the turn that is running now.
    expect(host.steer("and keep it short")).toBe(true);
    gates[1]?.();
    const resumed = await second;
    expect(resumed.reason).not.toBe("cancelled");
    expect(resumed.session.id).toBe(stopped.session.id);
    expect(resumed.session.turnCount).toBe(2);
  });
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

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
