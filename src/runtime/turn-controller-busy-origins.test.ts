import { describe, expect, it } from "vitest";

import { TurnController, wakeReasonSource } from "./turn-controller.js";

/** A `run()` body that holds its turn open until `release()`. */
function held(): { body: () => Promise<void>; release: () => void; started: () => boolean } {
  let release!: () => void;
  let started = false;
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return {
    release,
    started: () => started,
    body: async () => {
      started = true;
      await gate;
    },
  };
}

async function waitUntil(predicate: () => boolean, limit = 50): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  if (!predicate()) throw new Error("waitUntil: predicate never became true");
}

// ATO-2519: the desktop's quit question names what is running ("a reply in
// Telegram", "an API request"). It can only do that when the agent says
// where each busy turn came from; before this, busySessionIds() was all.
describe("TurnController.busyTurns (ATO-2519)", () => {
  it("reports each running turn with its origin, and the wake reason a scheduled one carries", async () => {
    const controller = new TurnController();
    const tg = held();
    const api = held();
    const task = held();

    const p1 = controller.enqueue({ sessionId: "tg", origin: "telegram", run: tg.body });
    const p2 = controller.enqueue({ sessionId: "api", origin: "http", run: api.body });
    const p3 = controller.enqueue({ sessionId: "task", origin: "scheduler", wakeReason: "webhook", run: task.body });
    await waitUntil(() => tg.started() && api.started() && task.started());

    expect(controller.busyTurns()).toEqual([
      { sessionId: "tg", origin: "telegram" },
      { sessionId: "api", origin: "http" },
      { sessionId: "task", origin: "scheduler", wakeReason: "webhook" },
    ]);
    // The old view is unchanged: the same sessions, ids only.
    expect([...controller.busySessionIds()]).toEqual(["tg", "api", "task"]);

    tg.release();
    await p1;
    expect(controller.busyTurns().map((t) => t.origin)).toEqual(["http", "scheduler"]);

    api.release();
    task.release();
    await Promise.all([p2, p3]);
    expect(controller.busyTurns()).toEqual([]);
  });

  it("a waiting submission is not busy: only the turn that holds the session is reported", async () => {
    const controller = new TurnController();
    const first = held();
    const p1 = controller.enqueue({ sessionId: "s", origin: "discord", run: first.body });
    const p2 = controller.enqueue({ sessionId: "s", origin: "http", run: async () => {} });
    await waitUntil(() => first.started());

    expect(controller.busyTurns()).toEqual([{ sessionId: "s", origin: "discord" }]);

    first.release();
    await Promise.all([p1, p2]);
    expect(controller.busyTurns()).toEqual([]);
  });

  it("hands out copies, so a caller cannot change what the controller holds", async () => {
    const controller = new TurnController();
    const turn = held();
    const p = controller.enqueue({ sessionId: "s", origin: "slack", run: turn.body });
    await waitUntil(() => turn.started());

    const snapshot = controller.busyTurns() as Array<{ origin: string }>;
    snapshot[0]!.origin = "http";
    expect(controller.busyTurns()[0]!.origin).toBe("slack");

    turn.release();
    await p;
  });
});

describe("wakeReasonSource (ATO-2519)", () => {
  it("reads session.metadata.wakeReason.source, and nothing from anything else", () => {
    expect(wakeReasonSource({ wakeReason: { source: "scheduler", taskId: "t1", at: 1 } })).toBe("scheduler");
    expect(wakeReasonSource({ wakeReason: { source: "" } })).toBeUndefined();
    expect(wakeReasonSource({ wakeReason: { source: 3 } })).toBeUndefined();
    expect(wakeReasonSource({ wakeReason: "scheduler" })).toBeUndefined();
    expect(wakeReasonSource({})).toBeUndefined();
    expect(wakeReasonSource(undefined)).toBeUndefined();
  });
});
