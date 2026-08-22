import { describe, expect, it, vi } from "vitest";

import { createEmptySessionState } from "../session/session-state.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { TuiAction } from "./tui-action.js";

/**
 * Detach semantics: creating or switching sessions while a turn is
 * running must neither refuse (the pre-detach behaviour) nor abort the
 * turn — it keeps running against its own session, per the concurrency
 * contract's cross-session parallelism.
 */

function session(id: string) {
  return createEmptySessionState({ id, workingDir: "/tmp" });
}

interface TurnHandle {
  text: string;
  sessionId: string;
  signal: AbortSignal;
  resolve: (overrides?: {
    reason?: string;
    undelivered?: readonly string[];
  }) => void;
}

function makeHarness(opts: { busySessions?: readonly string[] } = {}) {
  const turns: TurnHandle[] = [];
  const stored = [session("s-a"), session("s-b")];
  let created = 0;
  const denyPendingForSession = vi.fn(() => 0);
  const clearSessionGrants = vi.fn();
  const runtime = {
    createSession: () => {
      created += 1;
      const fresh = session(`s-new-${created}`);
      stored.unshift(fresh);
      return fresh;
    },
    steer: () => false,
    runTurn: (
      s: { id: string },
      text: string,
      turnOpts: { signal: AbortSignal },
    ) =>
      new Promise((res) => {
        turns.push({
          text,
          sessionId: s.id,
          signal: turnOpts.signal,
          resolve: (overrides = {}) =>
            res({
              session: session(s.id),
              reason: overrides.reason ?? "reply",
              stepCount: 1,
              ...(overrides.undelivered
                ? { undelivered: overrides.undelivered }
                : {}),
            }),
        });
      }),
    sessionStore: {
      listRecent: () => stored,
      load: (id: string) => stored.find((s) => s.id === id) ?? null,
      delete: () => undefined,
    },
    approvals: { clearSessionGrants, denyPendingForSession },
    turnController: {
      isBusy: (id: string) => (opts.busySessions ?? []).includes(id),
    },
    config: {
      update: { checkOnStartup: false, repo: "x/y" },
      tracing: { trace: { dir: "/tmp", enabled: false } },
    },
    profileStore: { list: () => [] },
    skillCatalog: [],
  } as unknown as AgentRuntime;
  const bus = makeTuiEventBus();
  const actions: TuiAction[] = [];
  bus.subscribe((a) => actions.push(a));
  const orchestrator = new ChatOrchestrator(runtime, bus, {
    maxSteps: 5,
    llamaUrl: "http://127.0.0.1:8080",
  });
  return { orchestrator, actions, turns, denyPendingForSession, clearSessionGrants };
}

function lastSwitch(actions: readonly TuiAction[]) {
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    const action = actions[i];
    if (action?.type === "session_switched") return action;
  }
  return null;
}

function warnTexts(actions: readonly TuiAction[]): string[] {
  return actions
    .filter(
      (a): a is Extract<TuiAction, { type: "system_message" }> =>
        a.type === "system_message",
    )
    .map((a) => a.text);
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ChatOrchestrator new/switch session while a turn is running", () => {
  it("newSession detaches the running turn instead of refusing or aborting it", () => {
    const { orchestrator, actions, turns } = makeHarness();
    orchestrator.sendMessage("long running work");
    expect(turns).toHaveLength(1);

    orchestrator.newSession();

    const switched = lastSwitch(actions);
    expect(switched?.sessionId).toBe("s-new-2");
    // The old turn keeps running: not aborted, and announced.
    expect(turns[0]?.signal.aborted).toBe(false);
    expect(
      warnTexts(actions).some((t) => t.includes("continues in the background")),
    ).toBe(true);
    // The new thread is immediately usable — a second turn starts in
    // parallel with the detached one (different sessions, no FIFO tie).
    orchestrator.sendMessage("fresh thread work");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.sessionId).toBe("s-new-2");
  });

  it("a detached turn's completion neither clobbers the visible session nor drains its queue", async () => {
    const { orchestrator, actions, turns } = makeHarness();
    orchestrator.sendMessage("old thread work");
    orchestrator.newSession();
    orchestrator.sendMessage("new thread work");
    orchestrator.sendMessage("parked for the new thread");
    expect(turns).toHaveLength(2);

    turns[0]?.resolve();
    await settle();

    // The parked message still waits for the NEW thread's turn.
    expect(turns).toHaveLength(2);
    expect(
      warnTexts(actions).some((t) => t.includes("background turn finished")),
    ).toBe(true);

    turns[1]?.resolve();
    await settle();
    expect(turns).toHaveLength(3);
    expect(turns[2]?.text).toBe("parked for the new thread");
    expect(turns[2]?.sessionId).toBe("s-new-2");
  });

  it("switching back mid-turn re-attaches the abort handle", () => {
    const { orchestrator, actions, turns } = makeHarness();
    orchestrator.sendMessage("work on the first thread");
    const firstThreadId = turns[0]?.sessionId ?? "";

    orchestrator.switchSession("s-b");
    expect(turns[0]?.signal.aborted).toBe(false);

    orchestrator.switchSession(firstThreadId);
    const switched = lastSwitch(actions);
    expect(switched?.sessionId).toBe(firstThreadId);
    expect(switched?.running).toBe(true);

    // Esc aborts the re-attached turn again.
    orchestrator.abortCurrentTurn();
    expect(turns[0]?.signal.aborted).toBe(true);
  });

  it("drops parked messages with a preview notice when switching away", () => {
    const { orchestrator, actions, turns } = makeHarness();
    orchestrator.sendMessage("running");
    orchestrator.sendMessage("parked message one");
    orchestrator.sendMessage("parked message two");
    expect(turns).toHaveLength(1);

    orchestrator.switchSession("s-b");

    const drop = warnTexts(actions).find((t) => t.includes("switched away"));
    expect(drop).toContain("2 parked messages");
    expect(drop).toContain("parked message one");
    expect(drop).toContain("parked message two");
    const lastQueue = actions
      .filter(
        (a): a is Extract<TuiAction, { type: "queue_changed" }> =>
          a.type === "queue_changed",
      )
      .at(-1);
    expect(lastQueue?.queued).toEqual([]);
  });

  it("denies the left thread's pending approval at the gate", () => {
    const { orchestrator, denyPendingForSession, turns } = makeHarness();
    orchestrator.sendMessage("running");
    const leftId = turns[0]?.sessionId ?? "";
    orchestrator.switchSession("s-b");
    expect(denyPendingForSession).toHaveBeenCalledTimes(1);
    expect(denyPendingForSession.mock.calls[0]?.[0]).toBe(leftId);
  });

  it("keeps the running thread's grants until its backgrounded turn ends", async () => {
    const { orchestrator, clearSessionGrants, turns } = makeHarness();
    orchestrator.sendMessage("running");
    const leftId = turns[0]?.sessionId ?? "";
    orchestrator.switchSession("s-b");
    // Not cleared at switch time: the turn still runs under them.
    expect(clearSessionGrants).not.toHaveBeenCalledWith(leftId);
    turns[0]?.resolve();
    await settle();
    expect(clearSessionGrants).toHaveBeenCalledWith(leftId);
  });

  it("announces (and does not re-queue) a detached turn's undelivered steers", async () => {
    const { orchestrator, actions, turns } = makeHarness();
    orchestrator.sendMessage("running");
    orchestrator.newSession();

    turns[0]?.resolve({ undelivered: ["correction that came too late"] });
    await settle();

    const notice = warnTexts(actions).find((t) =>
      t.includes("steering message"),
    );
    expect(notice).toContain("correction that came too late");
    // Nothing started a turn out of it on the new thread.
    expect(turns).toHaveLength(1);
  });

  it("switching to the thread already on screen mid-run is a no-op", () => {
    const { orchestrator, actions, turns } = makeHarness();
    orchestrator.sendMessage("running");
    orchestrator.sendMessage("parked");
    const before = actions.filter((a) => a.type === "session_switched").length;

    orchestrator.switchSession(turns[0]?.sessionId ?? "");

    expect(actions.filter((a) => a.type === "session_switched")).toHaveLength(
      before,
    );
    expect(turns[0]?.signal.aborted).toBe(false);
    // The parked queue survived — nothing was detached.
    const lastQueue = actions
      .filter(
        (a): a is Extract<TuiAction, { type: "queue_changed" }> =>
          a.type === "queue_changed",
      )
      .at(-1);
    expect(lastQueue?.queued).toEqual(["parked"]);
  });

  it("marks a switch into a session busy with a foreign-origin turn as running", () => {
    const { orchestrator, actions } = makeHarness({ busySessions: ["s-b"] });
    orchestrator.switchSession("s-b");
    expect(lastSwitch(actions)?.running).toBe(true);
  });

  it("quit aborts detached turns too", () => {
    const { orchestrator, turns } = makeHarness();
    orchestrator.sendMessage("running");
    orchestrator.newSession();
    expect(turns[0]?.signal.aborted).toBe(false);
    orchestrator.quit();
    expect(turns[0]?.signal.aborted).toBe(true);
  });
});
