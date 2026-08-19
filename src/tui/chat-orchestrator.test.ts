import { describe, expect, it, vi } from "vitest";

import { createEmptySessionState } from "../session/session-state.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { TuiAction } from "./tui-action.js";

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
function stubRuntime(runTurn: (text: string) => Promise<unknown>): AgentRuntime {
  return {
    createSession: () => session(),
    runTurn: (_s: unknown, text: string) => runTurn(text),
    sessionStore: { listRecent: () => [], load: () => null },
    approvals: { clearSessionGrants: () => undefined },
    config: { update: { checkOnStartup: false, repo: "x/y" }, tracing: { trace: { dir: "/tmp", enabled: false } } },
    profileStore: { list: () => [] },
    skillCatalog: [],
  } as unknown as AgentRuntime;
}

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
      llamaUrl: "http://127.0.0.1:8080",
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
      llamaUrl: "http://127.0.0.1:8080",
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
      { maxSteps: 5, llamaUrl: "http://127.0.0.1:8080" },
    );
    orchestrator.clearQueue();
    expect(queueSnapshots(actions)).toHaveLength(0);
  });
});

function queueSnapshots(actions: readonly TuiAction[]): readonly string[][] {
  return actions
    .filter((a): a is Extract<TuiAction, { type: "queue_changed" }> =>
      a.type === "queue_changed",
    )
    .map((a) => [...a.queued]);
}
