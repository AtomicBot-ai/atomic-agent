import { describe, expect, it, vi } from "vitest";
import { LOCAL_OUT_OF_MEMORY_CODE, LocalOutOfMemoryError } from "../../llm/index.js";
import type { AgentLoopEvent, LocalOutOfMemoryChoice, LocalOutOfMemoryPort } from "../agent-contract.js";
import {
  OUT_OF_MEMORY_CHOICES,
  OUT_OF_MEMORY_MAX_RESTARTS,
  OUT_OF_MEMORY_MIN_CONTEXT_WINDOW,
  formatOutOfMemoryRestarted,
  halveContextWindow,
  recoverFromOutOfMemory,
} from "./out-of-memory-recovery.js";
import { createTurnLoopState } from "./turn-state.js";

/**
 * ATO-334: a managed local model that ran out of memory is restarted
 * with half the context window (never below 32 768, at most three times
 * in a row), asking first when someone is watching the chat.
 */
function port(overrides: Partial<LocalOutOfMemoryPort> = {}): LocalOutOfMemoryPort {
  return {
    detect: vi.fn(() => null),
    canRestart: vi.fn(() => true),
    ask: vi.fn(async (): Promise<LocalOutOfMemoryChoice> => "restart_smaller"),
    restart: vi.fn(async () => true),
    ...overrides,
  };
}

function run(
  oom: LocalOutOfMemoryPort,
  opts: { contextWindow?: number; mode?: "ask" | "auto"; signal?: AbortSignal; restarts?: number } = {},
) {
  const events: AgentLoopEvent[] = [];
  const turn = createTurnLoopState();
  turn.oomRestarts = opts.restarts ?? 0;
  const outcome = recoverFromOutOfMemory(
    {
      sessionId: "s1",
      contextWindow: opts.contextWindow ?? 262_144,
      cause: new Error("llama-server returned 500"),
      options: {
        signal: opts.signal ?? new AbortController().signal,
        ...(opts.mode !== undefined ? { localOutOfMemory: opts.mode } : {}),
      },
    },
    { localOutOfMemory: oom, onEvent: (e) => events.push(e) },
    turn,
  );
  const oomEvents = () =>
    events.filter((e): e is Extract<AgentLoopEvent, { type: "local_model_out_of_memory" }> =>
      e.type === "local_model_out_of_memory");
  return { outcome, turn, oomEvents };
}

describe("halveContextWindow", () => {
  it("halves", () => {
    expect(halveContextWindow(262_144)).toBe(131_072);
  });

  it("never goes below the floor", () => {
    expect(halveContextWindow(40_000)).toBe(OUT_OF_MEMORY_MIN_CONTEXT_WINDOW);
  });

  it("has nothing left at the floor or for an unknown window", () => {
    expect(halveContextWindow(OUT_OF_MEMORY_MIN_CONTEXT_WINDOW)).toBeNull();
    expect(halveContextWindow(16_384)).toBeNull();
    expect(halveContextWindow(0)).toBeNull();
  });
});

describe("recoverFromOutOfMemory", () => {
  it("unattended: restarts with half the window without asking, and says so once", async () => {
    const oom = port();
    const { outcome, turn, oomEvents } = run(oom);
    expect(await outcome).toEqual({ kind: "retry_same" });
    expect(oom.ask).not.toHaveBeenCalled();
    expect(oom.restart).toHaveBeenCalledWith(131_072, expect.any(AbortSignal));
    expect(turn.oomRestarts).toBe(1);
    const restarted = oomEvents().filter((e) => e.phase === "restarted");
    expect(restarted).toHaveLength(1);
    expect(restarted[0]!.message).toBe(
      "The model ran out of memory, restarted it with a context window of 131072 tokens.",
    );
    expect(restarted[0]!.message).toBe(formatOutOfMemoryRestarted(131_072));
  });

  it("a person at the chat is asked first, with the three answers", async () => {
    const oom = port();
    const { outcome, oomEvents } = run(oom, { mode: "ask" });
    expect(await outcome).toEqual({ kind: "retry_same" });
    const asking = oomEvents().find((e) => e.phase === "asking");
    expect(asking?.options).toEqual(OUT_OF_MEMORY_CHOICES);
    expect(asking?.nextContextWindow).toBe(131_072);
    expect(asking?.questionId).toEqual(expect.any(String));
    expect(oom.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: asking?.questionId,
        sessionId: "s1",
        contextWindow: 262_144,
        nextContextWindow: 131_072,
      }),
      expect.any(AbortSignal),
    );
    expect(oom.restart).toHaveBeenCalledWith(131_072, expect.any(AbortSignal));
  });

  it.each<[LocalOutOfMemoryChoice, RegExp]>([
    ["pick_smaller_model", /Pick a smaller model/],
    ["cancel", /Stopped without restarting it/],
  ])("answered %s: stops without restarting", async (choice, sentence) => {
    const oom = port({ ask: vi.fn(async () => choice) });
    const { outcome, oomEvents } = run(oom, { mode: "ask" });
    const result = await outcome;
    expect(result.kind).toBe("stop");
    if (result.kind !== "stop") return;
    expect(result.error).toBeInstanceOf(LocalOutOfMemoryError);
    expect(result.error.reasonCode).toBe(LOCAL_OUT_OF_MEMORY_CODE);
    expect(result.error.message).toMatch(sentence);
    expect(oom.restart).not.toHaveBeenCalled();
    expect(oomEvents().at(-1)?.phase).toBe("stopped");
  });

  it("the third restart in a row is the last: the next one stops with plain text", async () => {
    const oom = port();
    const { outcome } = run(oom, { restarts: OUT_OF_MEMORY_MAX_RESTARTS, contextWindow: 65_536 });
    const result = await outcome;
    expect(result.kind).toBe("stop");
    if (result.kind !== "stop") return;
    expect(result.error.message).toBe(
      "The model ran out of memory 3 times in a row, even with a context window of 65536 tokens. Pick a smaller model.",
    );
    expect(oom.restart).not.toHaveBeenCalled();
  });

  it("at the floor there is nothing smaller to try: pick a smaller model", async () => {
    const oom = port();
    const result = await run(oom, { contextWindow: OUT_OF_MEMORY_MIN_CONTEXT_WINDOW }).outcome;
    expect(result.kind).toBe("stop");
    if (result.kind !== "stop") return;
    expect(result.error.message).toMatch(/Pick a smaller model/);
    expect(result.error.nextContextWindow).toBeNull();
    expect(oom.restart).not.toHaveBeenCalled();
  });

  it("nothing here can restart (headless serve): ends at once naming the window to restart with", async () => {
    const oom = port({ canRestart: () => false });
    const { outcome, oomEvents } = run(oom, { mode: "ask" });
    const result = await outcome;
    expect(result.kind).toBe("stop");
    if (result.kind !== "stop") return;
    expect(result.error.message).toBe(
      "The model ran out of memory with a context window of 262144 tokens. " +
        "Restart it with a smaller window (131072 tokens), or pick a smaller model.",
    );
    expect(result.error.nextContextWindow).toBe(131_072);
    expect(oom.ask).not.toHaveBeenCalled();
    expect(oomEvents().map((e) => e.phase)).toEqual(["stopped"]);
  });

  it("a restart that fails stops with plain text", async () => {
    const oom = port({ restart: vi.fn(async () => false) });
    const result = await run(oom).outcome;
    expect(result.kind).toBe("stop");
    if (result.kind !== "stop") return;
    expect(result.error.message).toMatch(/restarting it with a context window of 131072 tokens failed/);
  });

  it("a turn stopped while the question is open is cancelled", async () => {
    const controller = new AbortController();
    const oom = port({
      ask: vi.fn(async () => {
        controller.abort();
        throw new Error("approval aborted before a decision was made");
      }),
    });
    const result = await run(oom, { mode: "ask", signal: controller.signal }).outcome;
    expect(result).toEqual({ kind: "cancelled" });
    expect(oom.restart).not.toHaveBeenCalled();
  });
});
