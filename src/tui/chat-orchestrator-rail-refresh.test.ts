import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../runtime/bootstrap.js";
import { SessionStore } from "../session/session-store.js";
import { createEmptySessionState } from "../session/session-state.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { LocalTurnGateFacts } from "./local-turn-gate.js";
import type { TuiAction } from "./tui-action.js";

/**
 * The rail repaint in `runOneTurn`'s `finally` used to be able to end
 * the turn it was reporting on.
 *
 * `shutdown()` aborts the running turn and then closes the session
 * store without waiting for the turn's tail, so a tail that lands after
 * teardown reads a dead SQLite handle. better-sqlite3 answers that with
 * a `TypeError`, and a throw from inside `finally` replaces the turn's
 * outcome and skips everything after the block, while
 * `void this.runOneTurn(...)` turns the escape into an unhandled
 * rejection the crash reporter files. In the field that rejection is the
 * whole symptom: `shutdown()` calls `abortCurrentTurn()` first, so the
 * queue is already empty by the time the tail runs.
 *
 * The queue here is therefore a deliberately synthetic setup — the store
 * closed mid-turn with a message still parked. It earns its place by
 * pinning the control-flow escape itself (a `finally` that throws skips
 * `this.queue.shift()`), which is the mechanism the real symptom rides
 * on and the one thing an "it no longer throws" assertion cannot see.
 */

/** Hermetic gate facts: never read the developer's real config/disk. */
const cloudGateFacts = (): LocalTurnGateFacts => ({
  activeProviderIsLocal: false,
  managedMode: false,
  modelId: null,
  modelDownloaded: true,
  fallbackChainLength: 1,
});

function session(id = "s1") {
  return createEmptySessionState({ id, workingDir: "/tmp" });
}

interface Deferred {
  promise: Promise<unknown>;
  resolve: () => void;
}

function deferred(id: string): Deferred {
  let resolve!: () => void;
  const promise = new Promise<unknown>((res) => {
    resolve = () =>
      res({ session: session(id), reason: "reply", stepCount: 1 });
  });
  return { promise, resolve };
}

/**
 * Like the other orchestrator suites' stub, with `listSummaries`
 * delegating to a swappable function so a test can kill the store
 * mid-turn, and a real-shaped `logger` because the store-gone branch
 * writes a debug line through it.
 */
function stubRuntime(args: {
  runTurn: (text: string, opts: { signal: AbortSignal }) => Promise<unknown>;
  listSummaries: () => unknown[];
  onDebug?: (message: string) => void;
}): AgentRuntime {
  return {
    createSession: () => session(),
    steer: () => false,
    runTurn: (_s: unknown, text: string, opts: { signal: AbortSignal }) =>
      args.runTurn(text, opts),
    sessionStore: {
      listSummaries: () => args.listSummaries(),
      countUnreadable: () => 0,
      listRecent: () => [],
      load: () => null,
    },
    approvals: { clearSessionGrants: () => undefined },
    config: {
      update: { checkOnStartup: false, repo: "x/y" },
      tracing: { trace: { dir: "/tmp", enabled: false } },
    },
    profileStore: { list: () => [] },
    skillCatalog: [],
    logger: {
      debug: (message: string) => args.onDebug?.(message),
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as AgentRuntime;
}

describe("a closed SessionStore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-rail-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("answers a read with a TypeError, not a store-shaped error", () => {
    const store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite") });
    store.save(session("s1"));
    // Sanity: the read works while the handle is open, so the throw
    // below is the close and nothing else.
    expect(store.listSummaries()).toHaveLength(1);
    store.close();

    // This is the exact shape the rail guard keys on. If better-sqlite3
    // ever changes the wording, this test is what catches it.
    expect(() => store.listSummaries()).toThrow(TypeError);
    expect(() => store.listSummaries()).toThrow(
      /database connection is not open/,
    );
  });
});

describe("ChatOrchestrator rail refresh during teardown", () => {
  /** Let the turn's tail, and any escaping rejection, settle. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    await new Promise((res) => setImmediate(res));
  }

  it("still drains the queue when the store dies mid-turn", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    // Vitest installs its own handler; prepend so ours observes first and
    // keep the runner's in place — the shape
    // `agent-loop-reflection-fire-safety.test.ts` uses for the same job.
    process.prependListener("unhandledRejection", onRejection);
    try {
      let storeClosed = false;
      const first = deferred("s1");
      const second = deferred("s1");
      const seen: string[] = [];
      const debugLines: string[] = [];
      const runTurn = vi.fn((text: string) => {
        seen.push(text);
        return (seen.length === 1 ? first : second).promise;
      });
      const bus = makeTuiEventBus();
      const actions: TuiAction[] = [];
      bus.subscribe((a) => actions.push(a));
      const orchestrator = new ChatOrchestrator(
        stubRuntime({
          runTurn,
          listSummaries: () => {
            if (storeClosed) {
              throw new TypeError("The database connection is not open");
            }
            return [];
          },
          onDebug: (message) => debugLines.push(message),
        }),
        bus,
        {
          maxSteps: 5,
          llamaUrl: "http://127.0.0.1:8080",
          readGateFacts: cloudGateFacts,
        },
      );

      orchestrator.sendMessage("first");
      orchestrator.sendMessage("second");
      expect(seen).toEqual(["first"]);
      expect(queueSnapshots(actions).at(-1)).toEqual(["second"]);

      // Teardown closed the handle while the turn was still in flight.
      const repaintsBeforeClose = repaints(actions).length;
      storeClosed = true;
      first.resolve();
      await first.promise;
      await settle();

      // The tail after the `finally` ran: the parked message drained and
      // the strip was re-synced. Before the guard, `seen` stayed
      // `["first"]` — that is the escape, observed.
      expect(seen).toEqual(["first", "second"]);
      expect(queueSnapshots(actions).at(-1)).toEqual([]);
      // The rail skipped its repaint rather than painting a wrong list:
      // no `recent_sessions_updated` after the handle went away.
      expect(repaints(actions).length).toBe(repaintsBeforeClose);
      expect(repaintsBeforeClose).toBeGreaterThan(0);
      // …and said so where a developer can find it.
      expect(debugLines.some((line) => line.includes("rail refresh"))).toBe(
        true,
      );
      // A store that is gone on the way out is not an operator's
      // problem: no `session list unavailable:` line for it.
      expect(
        feedLines(actions).some((l) => l.includes("session list unavailable")),
      ).toBe(false);

      second.resolve();
      await second.promise;
      await settle();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("reports a rail failure that is not the store going away", async () => {
    let broken = false;
    const first = deferred("s1");
    const second = deferred("s1");
    const seen: string[] = [];
    const debugLines: string[] = [];
    const runTurn = vi.fn((text: string) => {
      seen.push(text);
      return (seen.length === 1 ? first : second).promise;
    });
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const orchestrator = new ChatOrchestrator(
      stubRuntime({
        runTurn,
        listSummaries: () => {
          if (broken) throw new Error("disk I/O error");
          return [];
        },
        onDebug: (message) => debugLines.push(message),
      }),
      bus,
      {
        maxSteps: 5,
        llamaUrl: "http://127.0.0.1:8080",
        readGateFacts: cloudGateFacts,
      },
    );

    orchestrator.sendMessage("first");
    orchestrator.sendMessage("second");
    const repaintsBeforeBreak = repaints(actions).length;
    broken = true;
    first.resolve();
    await first.promise;
    await settle();

    // Still not the turn's problem — the tail ran.
    expect(seen).toEqual(["first", "second"]);
    // But this one the operator sees, under the same line `start()` has
    // always used for a store that cannot list: a rail that quietly
    // stops repainting lies about which threads exist.
    expect(feedLines(actions)).toContain(
      "session list unavailable: disk I/O error",
    );
    // Reported, not repainted: the rail keeps the rows it had rather than
    // going empty, because a read that failed is not "no threads".
    expect(repaints(actions).length).toBe(repaintsBeforeBreak);
    expect(repaintsBeforeBreak).toBeGreaterThan(0);
    // Not swallowed into the debug log, which at the shipping
    // `log.level=info` nobody would ever see.
    expect(debugLines).toEqual([]);

    second.resolve();
    await second.promise;
  });

  it("does not throw out of a direct refreshRecentSessions call", () => {
    const bus = makeTuiEventBus();
    const orchestrator = new ChatOrchestrator(
      stubRuntime({
        runTurn: () => new Promise(() => undefined),
        listSummaries: () => {
          throw new TypeError("The database connection is not open");
        },
      }),
      bus,
      {
        maxSteps: 5,
        llamaUrl: "http://127.0.0.1:8080",
        readGateFacts: cloudGateFacts,
      },
    );
    // All nine of its call sites in `chat-orchestrator.ts` (seven direct,
    // two handed to sub-orchestrators as a callback) are repaints; none of
    // them wants an exception.
    expect(() => orchestrator.refreshRecentSessions()).not.toThrow();
  });
});

/**
 * How narrow the predicate is *is* the fix. Swallowing every session-store
 * failure would be the other half of this bug, so each of these is a real
 * error that reaches this code path and must stay visible — including the
 * one better-sqlite3 raises two lines below the closed-handle throw.
 */
describe("which rail failures count as the store being gone", () => {
  /**
   * One good refresh, then a refresh whose read throws `err`. Returns
   * what the second one said and whether it repainted.
   */
  function refreshAfter(err: unknown): {
    feed: readonly string[];
    debugLines: readonly string[];
    newRepaints: number;
  } {
    const bus = makeTuiEventBus();
    const actions: TuiAction[] = [];
    bus.subscribe((a) => actions.push(a));
    const debugLines: string[] = [];
    let live = true;
    const orchestrator = new ChatOrchestrator(
      stubRuntime({
        runTurn: () => new Promise(() => undefined),
        listSummaries: () => {
          if (!live) throw err;
          return [];
        },
        onDebug: (message) => debugLines.push(message),
      }),
      bus,
      {
        maxSteps: 5,
        llamaUrl: "http://127.0.0.1:8080",
        readGateFacts: cloudGateFacts,
      },
    );
    orchestrator.refreshRecentSessions();
    const repaintsBefore = repaints(actions).length;
    expect(repaintsBefore).toBe(1);
    live = false;
    orchestrator.refreshRecentSessions();
    return {
      feed: feedLines(actions),
      debugLines,
      newRepaints: repaints(actions).length - repaintsBefore,
    };
  }

  const visible: readonly [string, Error][] = [
    [
      // `macros.cpp:62`, two lines below the closed-handle throw: a LIVE
      // store refusing a re-entrant read. Same constructor, same first
      // two words, entirely different fault — and the one that makes the
      // exact-wording match load-bearing.
      "better-sqlite3's sibling TypeError for a busy connection",
      new TypeError("This database connection is busy executing a query"),
    ],
    [
      // A bug in `toPickerEntry` / `sessionRail.arrange`, i.e. the rail's
      // own code. Nothing to do with the store, must not go quiet.
      "an ordinary TypeError from the rail's own row mapping",
      new TypeError("row.map is not a function"),
    ],
    [
      // The closed-handle wording arriving on something better-sqlite3
      // did not throw — a rethrow or a wrapper — is not the raw race the
      // guard is allowed to swallow.
      "the closed-handle wording on an Error that is not a TypeError",
      new Error("The database connection is not open"),
    ],
  ];

  it.each(visible)("still reports %s", (_what, err) => {
    const { feed, debugLines, newRepaints } = refreshAfter(err);
    expect(feed).toEqual([`session list unavailable: ${err.message}`]);
    // Not demoted to a debug line, which at the shipping `log.level=info`
    // nobody would ever see.
    expect(debugLines).toEqual([]);
    // And the rail keeps the rows it had: a read that failed is not the
    // same answer as "there are no threads".
    expect(newRepaints).toBe(0);
  });

  it("goes quiet only for the closed handle", () => {
    const { feed, debugLines, newRepaints } = refreshAfter(
      new TypeError("The database connection is not open"),
    );
    expect(feed).toEqual([]);
    expect(debugLines).toHaveLength(1);
    expect(newRepaints).toBe(0);
  });
});

function queueSnapshots(actions: readonly TuiAction[]): readonly string[][] {
  return actions
    .filter(
      (a): a is Extract<TuiAction, { type: "queue_changed" }> =>
        a.type === "queue_changed",
    )
    .map((a) => [...a.queued]);
}

function repaints(
  actions: readonly TuiAction[],
): readonly Extract<TuiAction, { type: "recent_sessions_updated" }>[] {
  return actions.filter(
    (a): a is Extract<TuiAction, { type: "recent_sessions_updated" }> =>
      a.type === "recent_sessions_updated",
  );
}

function feedLines(actions: readonly TuiAction[]): readonly string[] {
  return actions
    .filter(
      (a): a is Extract<TuiAction, { type: "runtime_info" }> =>
        a.type === "runtime_info",
    )
    .map((a) => a.line);
}
