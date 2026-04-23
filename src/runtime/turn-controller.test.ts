import { describe, it, expect, vi } from "vitest";

import { TurnController } from "./turn-controller.js";
import type { AgentLoopEvent } from "../agent/agent-loop.js";

const mkEvent = (text: string): AgentLoopEvent => ({
  type: "user_message",
  text,
});

/**
 * Build a `run()` body that resolves only when its returned `release`
 * callback is invoked. Lets each test orchestrate the exact interleaving
 * of two submissions without relying on timers.
 */
function defer(): {
  promise: Promise<void>;
  release: () => void;
  body: () => Promise<void>;
  started: () => boolean;
} {
  let release!: () => void;
  let started = false;
  const promise = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return {
    promise,
    release,
    started: () => started,
    body: async () => {
      started = true;
      await promise;
    },
  };
}

/**
 * Pump microtasks until `predicate` returns true. Caps at `limit`
 * iterations so a wrong assumption fails fast instead of hanging the
 * test runner.
 */
async function waitUntil(
  predicate: () => boolean,
  limit = 50,
): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  if (!predicate()) {
    throw new Error(`waitUntil: predicate never became true (limit=${limit})`);
  }
}

describe("TurnController", () => {
  it("runs same-session submissions strictly FIFO", async () => {
    const controller = new TurnController();
    const order: string[] = [];

    const first = defer();
    const second = defer();
    const third = defer();

    const p1 = controller.enqueue({
      sessionId: "s1",
      origin: "http",
      run: async () => {
        order.push("first:start");
        await first.body();
        order.push("first:end");
      },
    });
    const p2 = controller.enqueue({
      sessionId: "s1",
      origin: "http",
      run: async () => {
        order.push("second:start");
        await second.body();
        order.push("second:end");
      },
    });
    const p3 = controller.enqueue({
      sessionId: "s1",
      origin: "scheduler",
      run: async () => {
        order.push("third:start");
        await third.body();
        order.push("third:end");
      },
    });

    await waitUntil(() => first.started());
    expect(order).toEqual(["first:start"]);
    expect(second.started()).toBe(false);
    expect(third.started()).toBe(false);

    first.release();
    await p1;
    await waitUntil(() => second.started());
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(third.started()).toBe(false);

    second.release();
    await p2;
    await waitUntil(() => third.started());
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
      "third:start",
    ]);

    third.release();
    await p3;
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
      "third:start",
      "third:end",
    ]);
  });

  it("runs different sessions concurrently", async () => {
    const controller = new TurnController();
    const a = defer();
    const b = defer();

    const pa = controller.enqueue({
      sessionId: "sA",
      origin: "http",
      run: a.body,
    });
    const pb = controller.enqueue({
      sessionId: "sB",
      origin: "http",
      run: b.body,
    });

    await waitUntil(() => a.started() && b.started());
    expect(controller.isBusy("sA")).toBe(true);
    expect(controller.isBusy("sB")).toBe(true);
    expect([...controller.busySessionIds()].sort()).toEqual(["sA", "sB"]);

    a.release();
    b.release();
    await Promise.all([pa, pb]);
    expect(controller.isBusy("sA")).toBe(false);
    expect(controller.isBusy("sB")).toBe(false);
    expect(controller.busySessionIds()).toEqual([]);
  });

  it("routes events only to the active submission's hook on the same session", async () => {
    const controller = new TurnController();
    const hookA = vi.fn<(e: AgentLoopEvent) => void>();
    const hookB = vi.fn<(e: AgentLoopEvent) => void>();

    const first = defer();
    const second = defer();

    const p1 = controller.enqueue({
      sessionId: "s1",
      origin: "http",
      eventHook: hookA,
      run: first.body,
    });
    const p2 = controller.enqueue({
      sessionId: "s1",
      origin: "http",
      eventHook: hookB,
      run: second.body,
    });

    // First submission has installed hook A; second is still waiting.
    await waitUntil(() => first.started());
    controller.emit("s1", mkEvent("from-A"));
    expect(hookA).toHaveBeenCalledTimes(1);
    expect(hookA).toHaveBeenCalledWith(mkEvent("from-A"));
    expect(hookB).not.toHaveBeenCalled();

    // After the first body resolves, hook A is uninstalled and hook B
    // takes over.
    first.release();
    await p1;
    await waitUntil(() => second.started());
    controller.emit("s1", mkEvent("from-B"));
    expect(hookA).toHaveBeenCalledTimes(1);
    expect(hookB).toHaveBeenCalledTimes(1);
    expect(hookB).toHaveBeenCalledWith(mkEvent("from-B"));

    // After the second body resolves, neither hook receives leftover
    // events emitted on the now-idle session.
    second.release();
    await p2;
    controller.emit("s1", mkEvent("after"));
    expect(hookA).toHaveBeenCalledTimes(1);
    expect(hookB).toHaveBeenCalledTimes(1);
  });

  it("isolates event hooks across sessions", async () => {
    const controller = new TurnController();
    const hookA = vi.fn<(e: AgentLoopEvent) => void>();
    const hookB = vi.fn<(e: AgentLoopEvent) => void>();
    const a = defer();
    const b = defer();

    const pa = controller.enqueue({
      sessionId: "sA",
      origin: "http",
      eventHook: hookA,
      run: a.body,
    });
    const pb = controller.enqueue({
      sessionId: "sB",
      origin: "http",
      eventHook: hookB,
      run: b.body,
    });

    await waitUntil(() => a.started() && b.started());

    controller.emit("sA", mkEvent("for-A"));
    controller.emit("sB", mkEvent("for-B"));

    expect(hookA).toHaveBeenCalledTimes(1);
    expect(hookA).toHaveBeenCalledWith(mkEvent("for-A"));
    expect(hookB).toHaveBeenCalledTimes(1);
    expect(hookB).toHaveBeenCalledWith(mkEvent("for-B"));

    // Cross-emits never reach the wrong hook.
    controller.emit("sA", mkEvent("still-for-A"));
    controller.emit("sB", mkEvent("still-for-B"));
    expect(hookA).toHaveBeenCalledTimes(2);
    expect(hookB).toHaveBeenCalledTimes(2);

    a.release();
    b.release();
    await Promise.all([pa, pb]);
  });

  it("does not break the queue when run() throws", async () => {
    const controller = new TurnController();
    const second = defer();
    let secondRan = false;

    const p1 = controller.enqueue({
      sessionId: "s1",
      origin: "http",
      run: async () => {
        throw new Error("boom");
      },
    });
    const p2 = controller.enqueue({
      sessionId: "s1",
      origin: "http",
      run: async () => {
        secondRan = true;
        await second.body();
      },
    });

    await expect(p1).rejects.toThrow("boom");
    await waitUntil(() => secondRan);

    second.release();
    await p2;
    expect(controller.isBusy("s1")).toBe(false);
  });

  it("rejects an aborted submission before run() executes", async () => {
    const controller = new TurnController();
    const blocker = defer();
    const ran = vi.fn();

    const pBlock = controller.enqueue({
      sessionId: "s1",
      origin: "http",
      run: blocker.body,
    });

    const ac = new AbortController();
    const pPending = controller.enqueue({
      sessionId: "s1",
      origin: "http",
      signal: ac.signal,
      run: async () => {
        ran();
      },
    });

    await waitUntil(() => blocker.started());
    ac.abort(new Error("waited too long"));

    await expect(pPending).rejects.toThrow("waited too long");
    expect(ran).not.toHaveBeenCalled();

    blocker.release();
    await pBlock;
    expect(controller.isBusy("s1")).toBe(false);
  });

  it("rejects synchronously when the signal is already aborted", async () => {
    const controller = new TurnController();
    const ac = new AbortController();
    ac.abort(new Error("pre-aborted"));
    const ran = vi.fn();

    await expect(
      controller.enqueue({
        sessionId: "s1",
        origin: "http",
        signal: ac.signal,
        run: async () => {
          ran();
        },
      }),
    ).rejects.toThrow("pre-aborted");
    expect(ran).not.toHaveBeenCalled();
  });

  it("flips isBusy true during run() and false after", async () => {
    const controller = new TurnController();
    const d = defer();
    expect(controller.isBusy("s1")).toBe(false);

    const p = controller.enqueue({
      sessionId: "s1",
      origin: "http",
      run: d.body,
    });
    await waitUntil(() => controller.isBusy("s1"));
    expect(controller.isBusy("s1")).toBe(true);

    d.release();
    await p;
    expect(controller.isBusy("s1")).toBe(false);
    expect(controller.busySessionIds()).toEqual([]);
  });

  it("orders a scheduler submission behind a user submission on the same session", async () => {
    const controller = new TurnController();
    const order: TurnSubmissionLog[] = [];
    const userTurn = defer();
    const wakeTurn = defer();

    const pUser = controller.enqueue({
      sessionId: "s1",
      origin: "http",
      run: async () => {
        order.push({ origin: "http", phase: "start" });
        await userTurn.body();
        order.push({ origin: "http", phase: "end" });
      },
    });
    const pWake = controller.enqueue({
      sessionId: "s1",
      origin: "scheduler",
      run: async () => {
        order.push({ origin: "scheduler", phase: "start" });
        await wakeTurn.body();
        order.push({ origin: "scheduler", phase: "end" });
      },
    });

    await waitUntil(() => order.length >= 1);
    expect(order).toEqual([{ origin: "http", phase: "start" }]);

    userTurn.release();
    await pUser;
    await waitUntil(() => order.length >= 3);
    expect(order).toEqual([
      { origin: "http", phase: "start" },
      { origin: "http", phase: "end" },
      { origin: "scheduler", phase: "start" },
    ]);

    wakeTurn.release();
    await pWake;
    expect(order).toEqual([
      { origin: "http", phase: "start" },
      { origin: "http", phase: "end" },
      { origin: "scheduler", phase: "start" },
      { origin: "scheduler", phase: "end" },
    ]);
  });

  it("does not block other sessions when one session's queue is busy", async () => {
    const controller = new TurnController();
    const a1 = defer();
    const a2 = defer();
    const b = defer();
    let bStarted = false;

    const pa1 = controller.enqueue({
      sessionId: "sA",
      origin: "http",
      run: a1.body,
    });
    const pa2 = controller.enqueue({
      sessionId: "sA",
      origin: "http",
      run: a2.body,
    });
    const pb = controller.enqueue({
      sessionId: "sB",
      origin: "http",
      run: async () => {
        bStarted = true;
        await b.body();
      },
    });

    await waitUntil(() => bStarted);
    // sB started even though sA still has a queued waiter.
    expect(bStarted).toBe(true);

    b.release();
    await pb;
    a1.release();
    await pa1;
    a2.release();
    await pa2;
  });

  it("swallows hook errors and reports them to onHookError", async () => {
    const onHookError = vi.fn();
    const controller = new TurnController({ onHookError });
    const d = defer();

    const p = controller.enqueue({
      sessionId: "s1",
      origin: "sidecar",
      eventHook: () => {
        throw new Error("hook boom");
      },
      run: async () => {
        controller.emit("s1", mkEvent("trigger"));
        await d.body();
      },
    });

    await waitUntil(() => onHookError.mock.calls.length > 0);
    expect(onHookError).toHaveBeenCalledTimes(1);
    const [err, ctx] = onHookError.mock.calls[0]!;
    expect((err as Error).message).toBe("hook boom");
    expect(ctx.sessionId).toBe("s1");

    d.release();
    await p;
  });
});

interface TurnSubmissionLog {
  origin: "http" | "scheduler";
  phase: "start" | "end";
}
