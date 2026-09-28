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
 * outcome and skips everything after the block — including
 * `this.queue.shift()`, so the next parked message never runs — while
 * `void this.runOneTurn(...)` turns the escape into an unhandled
 * rejection the crash reporter files.
 *
 * These tests pin the three halves of that: the store really does throw
 * a `TypeError` once closed, a throwing repaint no longer costs the turn
 * its tail, and a repaint that fails for any OTHER reason still says so
 * out loud.
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
    process.on("unhandledRejection", onRejection);
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
      // the strip was re-synced. This is the consequence, not the
      // symptom — before the guard, `seen` stayed `["first"]`.
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
    // Not swallowed into the debug log where nobody looks.
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
    // Every one of the thirteen call sites is a repaint; none of them
    // wants an exception.
    expect(() => orchestrator.refreshRecentSessions()).not.toThrow();
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
