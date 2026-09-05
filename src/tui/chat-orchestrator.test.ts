import { describe, expect, it, vi } from "vitest";

import { createEmptySessionState } from "../session/session-state.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { ChatOrchestrator, MAX_QUEUED_MESSAGES } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { LocalTurnGateFacts } from "./local-turn-gate.js";
import type { TuiAction } from "./tui-action.js";

/** Hermetic gate facts: never read the developer's real config/disk. */
const cloudGateFacts = (): LocalTurnGateFacts => ({
  activeProviderIsLocal: false,
  managedMode: false,
  modelId: null,
  modelDownloaded: true,
  fallbackChainLength: 1,
});

interface Deferred {
  promise: Promise<{ session: ReturnType<typeof session>; reason: string; stepCount: number }>;
  resolve: () => void;
}

function session(id = "s1") {
  return createEmptySessionState({ id, workingDir: "/tmp" });
}

function deferred(id: string): Deferred {
  let resolve!: () => void;
  const promise = new Promise<{
    session: ReturnType<typeof session>;
    reason: string;
    stepCount: number;
  }>((res) => {
    resolve = () => res({ session: session(id), reason: "reply", stepCount: 1 });
  });
  return { promise, resolve };
}

/**
 * Minimal `AgentRuntime` stand-in. Every sub-orchestrator the
 * `ChatOrchestrator` constructor builds only stores references and
 * subscribes to the bus, so nothing here needs to do I/O.
 */
function stubRuntime(
  runTurn: (
    text: string,
    opts: { signal: AbortSignal; maxSteps: number },
  ) => Promise<unknown>,
): AgentRuntime {
  return {
    createSession: () => session(),
    // The queue tests exercise the fallback path: a steer that is always
    // refused parks every mid-run submission in the orchestrator queue.
    steer: () => false,
    runTurn: (
      _s: unknown,
      text: string,
      opts: { signal: AbortSignal; maxSteps: number },
    ) =>
      runTurn(text, opts),
    sessionStore: { listRecent: () => [], load: () => null },
    approvals: { clearSessionGrants: () => undefined },
    config: { update: { checkOnStartup: false, repo: "x/y" }, tracing: { trace: { dir: "/tmp", enabled: false } } },
    profileStore: { list: () => [] },
    skillCatalog: [],
  } as unknown as AgentRuntime;
}

describe("ChatOrchestrator max steps", () => {
  it("uses an updated step budget on the next turn", async () => {
    const turn = deferred("s1");
    const runTurn = vi.fn(
      (_text: string, _opts: { signal: AbortSignal; maxSteps: number }) =>
        turn.promise,
    );
    const orchestrator = new ChatOrchestrator(
      stubRuntime(runTurn),
      makeTuiEventBus(),
      {
        maxSteps: 5,
        llamaUrl: "http://127.0.0.1:8080",
        readGateFacts: cloudGateFacts,
      },
    );

    expect(orchestrator.getMaxSteps()).toBe(5);
    orchestrator.setMaxSteps(41);
    expect(orchestrator.getMaxSteps()).toBe(41);
    orchestrator.sendMessage("next turn");

    expect(runTurn).toHaveBeenCalledWith(
      "next turn",
      expect.objectContaining({ maxSteps: 41 }),
    );
    turn.resolve();
    await turn.promise;
  });
});

describe("ChatOrchestrator message queue", () => {
  it("runs the first message and parks the second until the first settles", async () => {
    const first = deferred("s1");
    const second = deferred("s1");
    const seen: string[] = [];
    const runTurn = vi.fn((text: string) => {
      seen.push(text);
      return (seen.length === 1 ? first : second).promise;
    });
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(stubRuntime(runTurn), bus, {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:8080", readGateFacts: cloudGateFacts,
    });

    orchestrator.sendMessage("first");
    orchestrator.sendMessage("second");
    expect(seen).toEqual(["first"]);
    expect(queueSnapshots(actions).at(-1)).toEqual(["second"]);

    first.resolve();
    await first.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual(["first", "second"]);
    expect(queueSnapshots(actions).at(-1)).toEqual([]);
    second.resolve();
    await second.promise;
  });

  it("clearQueue drops parked messages without touching the running turn", async () => {
    const first = deferred("s1");
    const runTurn = vi.fn(() => first.promise);
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(stubRuntime(runTurn), bus, {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:8080", readGateFacts: cloudGateFacts,
    });

    orchestrator.sendMessage("running");
    orchestrator.sendMessage("parked-a");
    orchestrator.sendMessage("parked-b");
    expect(queueSnapshots(actions).at(-1)).toEqual(["parked-a", "parked-b"]);

    orchestrator.clearQueue();
    expect(queueSnapshots(actions).at(-1)).toEqual([]);
    expect(runTurn).toHaveBeenCalledTimes(1);

    first.resolve();
    await first.promise;
    await Promise.resolve();
    await Promise.resolve();
    // Nothing left to drain — the cleared queue really is empty.
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("clearQueue on an empty queue does not spam the bus", () => {
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(
      stubRuntime(() => new Promise(() => undefined)),
      bus,
      { maxSteps: 5, llamaUrl: "http://127.0.0.1:8080", readGateFacts: cloudGateFacts },
    );
    orchestrator.clearQueue();
    // The idle boundary re-syncs an (empty) queue unconditionally; what
    // must not happen is a non-empty snapshot or an "aborted:" notice.
    expect(queueSnapshots(actions).every((q) => q.length === 0)).toBe(true);
  });
});

describe("ChatOrchestrator abort", () => {
  it("discards parked messages instead of draining them into the next turn", async () => {
    const seen: string[] = [];
    const runTurn = vi.fn((text: string, opts: { signal: AbortSignal }) => {
      seen.push(text);
      return abortableTurn(opts.signal);
    });
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(stubRuntime(runTurn), bus, {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:8080", readGateFacts: cloudGateFacts,
    });

    orchestrator.sendMessage("running");
    orchestrator.sendMessage("parked-a");
    orchestrator.sendMessage("parked-b");
    expect(queueSnapshots(actions).at(-1)).toEqual(["parked-a", "parked-b"]);

    orchestrator.abortCurrentTurn();
    await settle();

    // One Esc stops everything: the parked messages must not become turns.
    expect(seen).toEqual(["running"]);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(queueSnapshots(actions).at(-1)).toEqual([]);
    const aborted = noticeLines(actions).find((l) =>
      l.startsWith("aborted: dropped 2 parked messages"),
    );
    expect(aborted).toBeDefined();
    // The dropped texts ride along so the operator can copy them back.
    expect(aborted).toContain("1. parked-a");
    expect(aborted).toContain("2. parked-b");
  });

  it("stays quiet when the abort had nothing parked to drop", async () => {
    const runTurn = vi.fn((_text: string, opts: { signal: AbortSignal }) =>
      abortableTurn(opts.signal),
    );
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(stubRuntime(runTurn), bus, {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:8080", readGateFacts: cloudGateFacts,
    });

    orchestrator.sendMessage("running");
    orchestrator.abortCurrentTurn();
    await settle();

    // The idle boundary re-syncs an (empty) queue unconditionally; what
    // must not happen is a non-empty snapshot or an "aborted:" notice.
    expect(queueSnapshots(actions).every((q) => q.length === 0)).toBe(true);
    expect(noticeLines(actions).filter((l) => l.startsWith("aborted:"))).toEqual(
      [],
    );
  });
});

describe("ChatOrchestrator queue bound", () => {
  it("caps the queue and names how many messages it dropped", async () => {
    const first = deferred("s1");
    const seen: string[] = [];
    const runTurn = vi.fn((text: string) => {
      seen.push(text);
      return first.promise;
    });
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(stubRuntime(runTurn), bus, {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:8080", readGateFacts: cloudGateFacts,
    });

    orchestrator.sendMessage("running");
    for (let i = 0; i < MAX_QUEUED_MESSAGES + 3; i += 1) {
      orchestrator.sendMessage(`parked-${i}`);
    }

    const queued = queueSnapshots(actions).at(-1) ?? [];
    expect(queued).toHaveLength(MAX_QUEUED_MESSAGES);
    // FIFO: the cap drops the newest arrivals, never the ones already parked.
    expect(queued[0]).toBe("parked-0");
    expect(queued.at(-1)).toBe(`parked-${MAX_QUEUED_MESSAGES - 1}`);
    expect(runTurn).toHaveBeenCalledTimes(1);

    const full = noticeLines(actions).filter((l) => l.startsWith("queue: full"));
    expect(full).toHaveLength(3);
    expect(full.at(-1)).toBe(
      `queue: full at ${MAX_QUEUED_MESSAGES} — dropped 3 messages (returned to the editor); Esc stops the run, /queue clear empties it`,
    );

    first.resolve();
    await settle();
    // Exactly the parked messages run — the refused ones are gone for good.
    expect(seen).toEqual(["running", ...queued]);
    expect(seen).not.toContain(`parked-${MAX_QUEUED_MESSAGES}`);
  });

  it("re-publishes the queue on a rejected push so an optimistic insert cannot stick", () => {
    const runTurn = vi.fn(() => new Promise<never>(() => undefined));
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(stubRuntime(runTurn), bus, {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:8080", readGateFacts: cloudGateFacts,
    });

    orchestrator.sendMessage("running");
    for (let i = 0; i < MAX_QUEUED_MESSAGES; i += 1) {
      orchestrator.sendMessage(`parked-${i}`);
    }
    const beforeDrop = queueSnapshots(actions).length;

    orchestrator.sendMessage("rejected");

    const snapshots = queueSnapshots(actions);
    expect(snapshots).toHaveLength(beforeDrop + 1);
    expect(snapshots.at(-1)).toHaveLength(MAX_QUEUED_MESSAGES);
    expect(snapshots.at(-1)).not.toContain("rejected");
  });

  it("forgets the drop counter once the queue has room again", async () => {
    const first = deferred("s1");
    const runTurn = vi.fn(() => first.promise);
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(stubRuntime(runTurn), bus, {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:8080", readGateFacts: cloudGateFacts,
    });

    orchestrator.sendMessage("running");
    for (let i = 0; i < MAX_QUEUED_MESSAGES + 2; i += 1) {
      orchestrator.sendMessage(`parked-${i}`);
    }
    orchestrator.clearQueue();
    orchestrator.sendMessage("after-clear");
    // Refills to exactly the cap, then one more that must be refused.
    for (let i = 0; i < MAX_QUEUED_MESSAGES; i += 1) {
      orchestrator.sendMessage(`again-${i}`);
    }

    const full = noticeLines(actions).filter((l) => l.startsWith("queue: full"));
    // Two drops before the clear, then the counter restarts at 1 after it.
    expect(full.at(-1)).toBe(
      `queue: full at ${MAX_QUEUED_MESSAGES} — dropped 1 message (returned to the editor); Esc stops the run, /queue clear empties it`,
    );
  });
});

describe("ChatOrchestrator pre-turn local gate", () => {
  const blockedFacts = (): LocalTurnGateFacts => ({
    activeProviderIsLocal: true,
    managedMode: true,
    modelId: "qwen-3.5-4b",
    modelDownloaded: false,
    fallbackChainLength: 1,
  });

  function gateBlocks(actions: readonly TuiAction[]): readonly string[] {
    return actions
      .filter((a): a is Extract<TuiAction, { type: "turn_gate_blocked" }> =>
        a.type === "turn_gate_blocked",
      )
      .map((a) => a.text);
  }

  it("blocks a fresh submit and returns the message to the editor", () => {
    const runTurn = vi.fn(() => Promise.resolve());
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(stubRuntime(runTurn), bus, {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:8080",
      readGateFacts: blockedFacts,
    });

    orchestrator.sendMessage("hello");

    expect(runTurn).not.toHaveBeenCalled();
    const blocks = gateBlocks(actions);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("qwen-3.5-4b");
    expect(blocks[0]).toContain("(message returned to the editor)");
    const restored = actions.find((a) => a.type === "input_changed");
    expect(restored).toEqual({ type: "input_changed", value: "hello" });
  });

  it("gates at drain time, not enqueue: a message queued mid-run is judged when it starts", async () => {
    // Model fine while the first turn runs; gone by the time the queue drains
    // (e.g. the operator switched the managed model mid-turn).
    let downloaded = true;
    const first = deferred("s1");
    const runTurn = vi.fn(() => first.promise);
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(stubRuntime(runTurn), bus, {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:8080",
      readGateFacts: () => ({
        ...blockedFacts(),
        modelDownloaded: downloaded,
      }),
    });

    orchestrator.sendMessage("first");
    orchestrator.sendMessage("second");
    // Enqueue itself is never gated — the message parks normally.
    expect(gateBlocks(actions)).toHaveLength(0);
    expect(queueSnapshots(actions).at(-1)).toEqual(["second"]);

    downloaded = false;
    first.resolve();
    await first.promise;
    await Promise.resolve();
    await Promise.resolve();

    // Only the first message ever reached the runtime; the drained one
    // was blocked at ITS turn start and dropped with a preview.
    expect(runTurn).toHaveBeenCalledTimes(1);
    const blocks = gateBlocks(actions);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("dropped: second");
  });

  it("with a fallback chain (>1 link) it notices and still runs the turn", async () => {
    const first = deferred("s1");
    const runTurn = vi.fn(() => first.promise);
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(stubRuntime(runTurn), bus, {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:8080",
      readGateFacts: () => ({ ...blockedFacts(), fallbackChainLength: 2 }),
    });

    orchestrator.sendMessage("hello");

    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(gateBlocks(actions)).toHaveLength(0);
    const notice = noticeLines(actions).find((l) =>
      l.includes("fallback chain"),
    );
    expect(notice).toContain("qwen-3.5-4b");
    first.resolve();
    await first.promise;
  });

  it("cloud turns never see the gate", () => {
    const runTurn = vi.fn(() => Promise.resolve());
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(stubRuntime(runTurn), bus, {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:8080",
      readGateFacts: () => ({
        ...blockedFacts(),
        activeProviderIsLocal: false,
      }),
    });

    orchestrator.sendMessage("hello");

    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(gateBlocks(actions)).toHaveLength(0);
  });
});

/**
 * A turn that never settles on its own and rejects the moment the
 * orchestrator aborts it — what `runtime.runTurn` really does, and the
 * only shape that exercises `runOneTurn`'s catch-then-drain tail.
 */
function abortableTurn(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

/** Let the orchestrator's post-turn continuation (catch → finally → drain) run. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function noticeLines(actions: readonly TuiAction[]): readonly string[] {
  return actions
    .filter((a): a is Extract<TuiAction, { type: "runtime_info" }> =>
      a.type === "runtime_info",
    )
    .map((a) => a.line);
}

function queueSnapshots(actions: readonly TuiAction[]): readonly string[][] {
  return actions
    .filter((a): a is Extract<TuiAction, { type: "queue_changed" }> =>
      a.type === "queue_changed",
    )
    .map((a) => [...a.queued]);
}
