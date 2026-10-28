import { describe, expect, it, vi } from "vitest";
import { TransportError } from "../../llm/index.js";
import { attachFailingLink } from "../../llm/fallback/failed-attempts.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { AgentLoopEvent, LocalOutOfMemoryPort } from "../agent-contract.js";
import { recoverTurnStep, type TurnRecoveryContext } from "./turn-recovery.js";
import { createTurnLoopState } from "./turn-state.js";

/**
 * ATO-334: a 500 from a managed local model whose log shows out of
 * memory is not an outage to wait out. Recovery hands it to the loop as
 * `local_out_of_memory`; every other 500 keeps the ordinary wait.
 */
function context(overrides: Partial<TurnRecoveryContext> = {}): TurnRecoveryContext {
  return {
    state: createEmptySessionState({ id: "oom", workingDir: "/work" }),
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

function serverError(link: string, status = 500): TransportError {
  const err = new TransportError(`llama-server returned ${status}`, status, "http://127.0.0.1:8080/v1/chat/completions");
  attachFailingLink(err, link);
  return err;
}

/** The runtime's reading in miniature: only the managed link ran out of memory. */
function port(contextWindow: number | null): LocalOutOfMemoryPort {
  return {
    detect: vi.fn((providerId: string | undefined) =>
      providerId === "local-llama" && contextWindow !== null ? { contextWindow } : null),
    canRestart: () => true,
    ask: vi.fn(async () => "restart_smaller" as const),
    restart: vi.fn(async () => true),
  };
}

describe("turn recovery: local model out of memory", () => {
  it("an out-of-memory 500 is not waited on: the loop gets the window to halve", () => {
    const events: AgentLoopEvent[] = [];
    const oom = port(262_144);
    const decision = recoverTurnStep(serverError("local-llama"), context(), {
      localOutOfMemory: oom,
      onEvent: (e) => events.push(e),
    }, createTurnLoopState());
    expect(decision.kind).toBe("local_out_of_memory");
    if (decision.kind !== "local_out_of_memory") return;
    expect(decision.contextWindow).toBe(262_144);
    expect(oom.detect).toHaveBeenCalledWith("local-llama");
    expect(events.some((e) => e.type === "provider_waiting")).toBe(false);
    expect(events.some((e) => e.type === "loop_failed")).toBe(false);
  });

  it("a 500 with no out-of-memory in the log keeps the outage wait", () => {
    const decision = recoverTurnStep(serverError("local-llama"), context(), {
      localOutOfMemory: port(null),
    }, createTurnLoopState());
    expect(decision.kind).toBe("wait");
  });

  it("a cloud link's 500 keeps the outage wait", () => {
    const oom = port(262_144);
    const decision = recoverTurnStep(serverError("openrouter", 503), context(), { localOutOfMemory: oom }, createTurnLoopState());
    expect(decision.kind).toBe("wait");
  });

  it("a refused connection is not read as out of memory: no server answered", () => {
    const err = new TransportError("fetch failed", null, "http://127.0.0.1:8080/v1/chat/completions");
    attachFailingLink(err, "local-llama");
    const oom = port(262_144);
    const decision = recoverTurnStep(err, context(), { localOutOfMemory: oom }, createTurnLoopState());
    expect(decision.kind).toBe("wait");
    expect(oom.detect).not.toHaveBeenCalled();
  });

  it("without the port (embedders, tests) a 500 waits as before", () => {
    const decision = recoverTurnStep(serverError("local-llama"), context(), {}, createTurnLoopState());
    expect(decision.kind).toBe("wait");
  });

  it("a stopped turn is cancelled, not restarted", () => {
    const controller = new AbortController();
    controller.abort();
    const decision = recoverTurnStep(
      serverError("local-llama"),
      context({ options: { maxSteps: 4, signal: controller.signal } }),
      { localOutOfMemory: port(262_144) },
      createTurnLoopState(),
    );
    expect(decision.kind).toBe("failure");
    if (decision.kind !== "failure") return;
    expect(decision.cancelled).toBe(true);
  });
});
