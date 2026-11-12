import { describe, expect, it, vi } from "vitest";
import { LlamaServerError, TransportError } from "../../llm/index.js";
import { attachFailingLink } from "../../llm/fallback/failed-attempts.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { AgentLoopEvent, LocalEngineState } from "../agent-contract.js";
import { recoverTurnStep, type TurnRecoveryContext } from "./turn-recovery.js";
import { createTurnLoopState } from "./turn-state.js";

/**
 * ATO-1279: the managed local model is running but cuts a reply off
 * mid-stream (a broken connection, or a 5xx error event inside the
 * stream). The step is retried once, at once; a second cut on the same
 * step ends the turn instead of waiting.
 */
function context(overrides: Partial<TurnRecoveryContext> = {}): TurnRecoveryContext {
  return {
    state: createEmptySessionState({ id: "cut", workingDir: "/work" }),
    options: { maxSteps: 4, signal: new AbortController().signal },
    stepIndex: 0,
    finalizationStep: false,
    noticeForThisStep: undefined,
    effectiveTransport: "grammar",
    requestDeadline: { dispose() {}, fired: () => false },
    resumesStoppedTask: false,
    taskStartedAt: 0,
    durationCeilingMs: 1_000_000,
    providerWaitCfg: { enabled: true, maxWaitMs: 300_000 },
    recoveryStepAvailable: () => true,
    ...overrides,
  };
}

const URL = "http://127.0.0.1:9931/completion";

/** What the step executor throws for a cut stream: the client's error, wrapped. */
function cut(
  opts: { status?: number | null; midStream?: boolean; timedOut?: boolean; link?: string } = {},
): TransportError {
  const status = opts.status === undefined ? null : opts.status;
  const inner = new LlamaServerError(
    status === null ? "terminated" : `llama-server reported an error mid-stream (http ${status})`,
    status,
    URL,
    opts.timedOut ?? false,
    status === null ? "ECONNRESET" : undefined,
    { midStream: opts.midStream ?? true },
  );
  const err = new TransportError(inner.message, status, URL, { cause: inner });
  attachFailingLink(err, opts.link ?? "local-llama");
  return err;
}

function engine(state: LocalEngineState) {
  return vi.fn((providerId: string | undefined): LocalEngineState =>
    providerId === "local-llama" ? state : "unknown");
}

describe("turn recovery: managed local model cut the reply mid-stream", () => {
  it("retries the step once, then fails on the second cut of the same step without waiting", () => {
    const turn = createTurnLoopState();
    const events: AgentLoopEvent[] = [];
    const deps = { localEngineState: engine("alive"), onEvent: (e: AgentLoopEvent) => events.push(e) };

    expect(recoverTurnStep(cut(), context(), deps, turn)).toEqual({ kind: "retry_same" });
    expect(turn.localStreamCutRetry).toEqual({ stepIndex: 0 });
    expect(events).toEqual([]);

    const second = recoverTurnStep(cut(), context(), deps, turn);
    expect(second.kind).toBe("failure");
    if (second.kind === "failure") {
      expect(second.category).toBe("transport");
      expect(second.cancelled).toBe(false);
    }
    expect(events.map((e) => e.type)).toEqual(["loop_failed"]);
    expect(turn.outageAttempts).toBe(0);
  });

  it("retries a 5xx error event inside the stream the same way, and a later step gets its own retry", () => {
    const turn = createTurnLoopState();
    const deps = { localEngineState: engine("alive") };
    expect(recoverTurnStep(cut({ status: 500 }), context(), deps, turn).kind).toBe("retry_same");
    expect(recoverTurnStep(cut({ status: 500 }), context({ stepIndex: 1 }), deps, turn).kind).toBe("retry_same");
    expect(turn.localStreamCutRetry).toEqual({ stepIndex: 1 });
  });

  it("does not retry when the turn was cancelled", () => {
    const controller = new AbortController();
    controller.abort();
    const turn = createTurnLoopState();
    const decision = recoverTurnStep(
      cut(),
      context({ options: { maxSteps: 4, signal: controller.signal } }),
      { localEngineState: engine("alive") },
      turn,
    );
    expect(decision.kind).toBe("failure");
    if (decision.kind === "failure") expect(decision.cancelled).toBe(true);
    expect(turn.localStreamCutRetry).toBeNull();
  });

  it("leaves the ordinary paths alone: a dead engine, a link that is not ours, our own deadline, a plain 500 on the open", () => {
    for (const [err, state] of [
      [cut(), "dead"],
      [cut({ link: "openrouter" }), "alive"],
      [cut({ timedOut: true }), "alive"],
      [cut({ status: 500, midStream: false }), "alive"],
      [cut({ status: 400 }), "alive"],
    ] as const) {
      const turn = createTurnLoopState();
      const decision = recoverTurnStep(err, context(), { localEngineState: engine(state) }, turn);
      expect(turn.localStreamCutRetry).toBeNull();
      expect(decision.kind).not.toBe("retry_same");
    }
  });

  it("is not taken when the out-of-memory check claims the failure first", () => {
    const turn = createTurnLoopState();
    const decision = recoverTurnStep(
      cut({ status: 500 }),
      context(),
      {
        localEngineState: engine("alive"),
        localOutOfMemory: {
          detect: () => ({ contextWindow: 65_536 }),
          canRestart: () => true,
          ask: async () => "restart_smaller",
          restart: async () => true,
        },
      },
      turn,
    );
    expect(decision.kind).toBe("local_out_of_memory");
    expect(turn.localStreamCutRetry).toBeNull();
  });
});
