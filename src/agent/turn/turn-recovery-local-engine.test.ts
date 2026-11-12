import { describe, expect, it, vi } from "vitest";
import { LOCAL_ENGINE_DOWN_CODE, LOCAL_ENGINE_DOWN_MESSAGE, LOCAL_PORT_TAKEN_CODE, LlamaServerError, LocalEngineDownError, LocalPortTakenError, TransportError } from "../../llm/index.js";
import { keyRefusedError } from "../../llm/llama-server-client.js";
import { attachFailingLink } from "../../llm/fallback/failed-attempts.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { AgentLoopEvent, LocalEngineState } from "../agent-contract.js";
import { LOCAL_ENGINE_RESTART_GRACE_MS, recoverTurnStep, type TurnRecoveryContext } from "./turn-recovery.js";
import { createTurnLoopState } from "./turn-state.js";

/**
 * ATO-772: a refused connection to the managed local model whose process
 * is certainly gone ends the turn with `LocalEngineDownError` instead of
 * parking it for the whole `agent.providerWait` budget. A live or unknown
 * engine, a cloud link and an external server keep the wait unchanged.
 */
function context(overrides: Partial<TurnRecoveryContext> = {}): TurnRecoveryContext {
  return {
    state: createEmptySessionState({ id: "engine", workingDir: "/work" }),
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

function refused(link: string, url = "http://127.0.0.1:8080/v1/chat/completions"): TransportError {
  const err = new TransportError("fetch failed", null, url, {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" }),
  });
  attachFailingLink(err, link);
  return err;
}

/** The runtime's reading in miniature: only the managed link is judged. */
function engine(state: LocalEngineState) {
  return vi.fn((providerId: string | undefined): LocalEngineState =>
    providerId === "local-llama" ? state : "unknown");
}

describe("turn recovery: managed local engine down", () => {
  it("ECONNREFUSED with the process dead ends the turn once the restart grace is spent, with no provider_waiting", () => {
    const turn = createTurnLoopState();
    turn.outageWaitedMs = LOCAL_ENGINE_RESTART_GRACE_MS;
    const events: AgentLoopEvent[] = [];
    const err = refused("local-llama");
    const decision = recoverTurnStep(err, context(), { localEngineState: engine("dead"), onEvent: (e) => events.push(e) }, turn);
    expect(decision.kind).toBe("failure");
    if (decision.kind !== "failure") return;
    expect(decision.category).toBe("transport");
    expect(decision.cancelled).toBe(false);
    expect(decision.runError).toBeInstanceOf(LocalEngineDownError);
    expect(decision.runError.message).toBe(LOCAL_ENGINE_DOWN_MESSAGE);
    expect((decision.runError as LocalEngineDownError).reasonCode).toBe(LOCAL_ENGINE_DOWN_CODE);
    expect((decision.runError as { cause?: unknown }).cause).toBe(err);
    expect(events.map((e) => e.type)).toEqual(["loop_failed"]);
    expect(turn.outageAttempts).toBe(0);
  });

  it("with waiting disabled the turn ends at once with the same reason", () => {
    const decision = recoverTurnStep(refused("local-llama"), context({ providerWaitCfg: { enabled: false, maxWaitMs: 300_000 } }), { localEngineState: engine("dead") }, createTurnLoopState());
    expect(decision.kind).toBe("failure");
    if (decision.kind === "failure") expect(decision.runError).toBeInstanceOf(LocalEngineDownError);
  });

  it("a dead engine is looked at again every 2 s during the grace, then the turn ends: seconds, not the five-minute budget", () => {
    const turn = createTurnLoopState();
    const events: AgentLoopEvent[] = [];
    const deps = { localEngineState: engine("dead"), onEvent: (e: AgentLoopEvent) => events.push(e) };
    const waits: number[] = [];
    for (;;) {
      const decision = recoverTurnStep(refused("local-llama"), context(), deps, turn);
      if (decision.kind !== "wait") {
        expect(decision.kind).toBe("failure");
        break;
      }
      waits.push(decision.nextRetryMs);
      turn.outageWaitedMs += decision.nextRetryMs;
    }
    expect(waits).toEqual([2_000, 2_000, 2_000, 2_000]);
    expect(turn.outageWaitedMs).toBe(LOCAL_ENGINE_RESTART_GRACE_MS);
    // The first refusal is still told to hosts: the desktop's supervisor
    // takes it as the second witness and starts its restart at once.
    expect(events[0]).toMatchObject({ type: "provider_waiting", providerId: "local-llama", nextRetryMs: 2_000 });
    expect(events.at(-1)).toMatchObject({ type: "loop_failed" });
  });

  it("a budget shorter than the grace ends with the reason, not the bare connection error", () => {
    const turn = createTurnLoopState();
    turn.outageWaitedMs = 1_000;
    const decision = recoverTurnStep(refused("local-llama"), context({ providerWaitCfg: { enabled: true, maxWaitMs: 1_000 } }), { localEngineState: engine("dead") }, turn);
    expect(decision.kind).toBe("failure");
    if (decision.kind === "failure") expect(decision.runError).toBeInstanceOf(LocalEngineDownError);
  });

  it("ECONNREFUSED with the process alive waits exactly as before (a restart or a model load)", () => {
    const turn = createTurnLoopState();
    turn.outageAttempts = 3;
    turn.outageWaitedMs = 60_000;
    const events: AgentLoopEvent[] = [];
    const decision = recoverTurnStep(refused("local-llama"), context(), { localEngineState: engine("alive"), onEvent: (e) => events.push(e) }, turn);
    expect(decision).toEqual({ kind: "wait", nextRetryMs: 16_000 });
    expect(events[0]).toMatchObject({ type: "provider_waiting", reason: "fetch failed" });
  });

  it("an unknown engine state (start or install under way) waits exactly as before", () => {
    const turn = createTurnLoopState();
    turn.outageWaitedMs = 60_000;
    const decision = recoverTurnStep(refused("local-llama"), context(), { localEngineState: engine("unknown") }, turn);
    expect(decision).toEqual({ kind: "wait", nextRetryMs: 2_000 });
  });

  it("a cloud provider's fetch failed waits as before, whatever the local engine is doing", () => {
    const turn = createTurnLoopState();
    turn.outageWaitedMs = 60_000;
    const probe = engine("dead");
    const decision = recoverTurnStep(refused("openrouter", "https://openrouter.ai/api/v1/chat/completions"), context(), { localEngineState: probe }, turn);
    expect(decision).toEqual({ kind: "wait", nextRetryMs: 2_000 });
    expect(probe).toHaveBeenCalledWith("openrouter");
  });

  it("external mode (the runtime answers unknown for it) waits as before", () => {
    const turn = createTurnLoopState();
    turn.outageWaitedMs = 60_000;
    const decision = recoverTurnStep(refused("local-llama"), context(), { localEngineState: () => "unknown" }, turn);
    expect(decision).toEqual({ kind: "wait", nextRetryMs: 2_000 });
  });

  it("an HTTP answer (503) is a server that answered, so a dead pid does not end the turn", () => {
    const turn = createTurnLoopState();
    turn.outageWaitedMs = 60_000;
    const err = new TransportError("llama-server 503", 503, "http://127.0.0.1:8080/v1/chat/completions");
    attachFailingLink(err, "local-llama");
    const probe = engine("dead");
    const decision = recoverTurnStep(err, context(), { localEngineState: probe }, turn);
    expect(decision).toEqual({ kind: "wait", nextRetryMs: 2_000 });
    expect(probe).not.toHaveBeenCalled();
  });

  it("without the dependency (embedders, tests) nothing changes", () => {
    const turn = createTurnLoopState();
    turn.outageWaitedMs = 60_000;
    const decision = recoverTurnStep(refused("local-llama"), context(), {}, turn);
    expect(decision).toEqual({ kind: "wait", nextRetryMs: 2_000 });
  });
});

/**
 * ATO-1277: the managed engine's address answered 401 while our engine's
 * process is not there. The server that refused the key is another
 * program on the port, so the turn ends with `local_port_taken` instead
 * of "the local model server refused the agent's key".
 */
describe("turn recovery: a 401 on the managed port with our engine gone", () => {
  const URL = "http://127.0.0.1:9931/completion";

  /** A standing 401 the way the llama client throws it, wrapped like `toLlmFailure` does. */
  function unauthorized(link: string, url = URL): TransportError {
    const refusal = keyRefusedError(new LlamaServerError("llama-server returned http 401", 401, url));
    const err = new TransportError(refusal.message, 401, url, { cause: refusal });
    attachFailingLink(err, link);
    return err;
  }

  it("no pid (or a dead one) ends with LocalPortTakenError, keeping the 401, the URL and the refusal", () => {
    const err = unauthorized("local-llama");
    const events: AgentLoopEvent[] = [];
    const decision = recoverTurnStep(err, context(), { localEngineState: engine("dead"), onEvent: (e) => events.push(e) }, createTurnLoopState());
    expect(decision.kind).toBe("failure");
    if (decision.kind !== "failure") return;
    expect(decision.category).toBe("transport");
    expect(decision.runError).toBeInstanceOf(LocalPortTakenError);
    const taken = decision.runError as LocalPortTakenError;
    expect(taken.reasonCode).toBe(LOCAL_PORT_TAKEN_CODE);
    expect(taken.status).toBe(401);
    expect(taken.url).toBe(URL);
    expect((taken as { cause?: unknown }).cause).toBe(err);
    expect(taken.message).toContain("Another program is using the local model's port");
    expect(taken.message).toContain("localModels.managed.port");
    expect(taken.message).not.toContain("refused the agent's key");
    expect(events.at(-1)).toMatchObject({ type: "loop_failed", failure: { cause: "local_port_taken" } });
  });

  it("with our engine alive the refused-key words stay", () => {
    const err = unauthorized("local-llama");
    const decision = recoverTurnStep(err, context(), { localEngineState: engine("alive") }, createTurnLoopState());
    expect(decision.kind).toBe("failure");
    if (decision.kind !== "failure") return;
    expect(decision.runError).toBe(err);
    expect(decision.runError.message).toContain("refused the agent's key");
  });

  it("an unknown engine state (start or install under way, external mode) keeps the old error", () => {
    const err = unauthorized("local-llama");
    const decision = recoverTurnStep(err, context(), { localEngineState: engine("unknown") }, createTurnLoopState());
    expect(decision.kind === "failure" && decision.runError).toBe(err);
  });

  it("a llama-server entry under another id is not the managed engine, whatever the pid says", () => {
    const err = unauthorized("my-llama");
    const probe = engine("dead");
    const decision = recoverTurnStep(err, context(), { localEngineState: probe }, createTurnLoopState());
    expect(decision.kind === "failure" && decision.runError).toBe(err);
    expect(probe).toHaveBeenCalledWith("my-llama");
  });

  it("a cloud provider's 401 is not read as a taken port", () => {
    const err = new TransportError("openai provider 401: bad key", 401, "https://openrouter.ai/api/v1/chat/completions");
    attachFailingLink(err, "local-llama");
    const probe = engine("dead");
    const decision = recoverTurnStep(err, context(), { localEngineState: probe }, createTurnLoopState());
    expect(decision.kind === "failure" && decision.runError).toBe(err);
    expect(probe).not.toHaveBeenCalled();
  });
});
