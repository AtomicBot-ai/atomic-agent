import { describe, expect, it } from "vitest";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { SteeringInbox } from "../../runtime/steering-inbox.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
import {
  FusionLiveWorkers,
  formatPersonSteer,
  type LiveWorkerControls,
} from "./escalation.js";
import type { DelegateTask } from "./delegate-args.js";

/**
 * The person's note to one running worker (ATO-568): it is routed by
 * the parent session and the task id to that worker's own inbox, read
 * at the worker's next step boundary, and never reaches a sibling or
 * another session's worker.
 */

type TurnOptions = Parameters<WorkerRunnerDeps["runTurn"]>[2];

const BASE = {
  parentSessionId: "s-parent",
  providerId: "local",
  workerModel: "small",
  workerMaxSteps: 20,
  workerTimeoutMs: 600_000,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

function reply(session: SessionState, undelivered?: readonly string[]): RunTurnResult {
  return {
    session,
    reason: "reply",
    stepCount: 1,
    ...(undelivered === undefined ? {} : { undelivered }),
  } as RunTurnResult;
}

/**
 * A worker turn that behaves like `AgentLoop` towards the inbox: opens
 * it on entry, drains it when the test says a step boundary came, and
 * closes it on the way out, handing back what it never read.
 */
function inboxHarness(inbox: SteeringInbox, live: FusionLiveWorkers) {
  let minted = 0;
  const read = new Map<string, string[]>();
  const boundaries = new Map<string, () => void>();
  const finishers = new Map<string, () => void>();
  const sessionByTask = new Map<string, string>();
  const deps: WorkerRunnerDeps = {
    runTurn: (session: SessionState, _message: string, options: TurnOptions) =>
      new Promise<RunTurnResult>((resolve) => {
        inbox.open(session.id);
        const taskId = (session.metadata as { fusionWorker?: { taskId?: string } })
          .fusionWorker?.taskId;
        if (taskId !== undefined) sessionByTask.set(taskId, session.id);
        boundaries.set(session.id, () => {
          read.set(session.id, [...(read.get(session.id) ?? []), ...inbox.drain(session.id)]);
        });
        finishers.set(session.id, () => resolve(reply(session, inbox.closeAndDrain(session.id))));
        options.signal?.addEventListener("abort", () =>
          resolve({ ...reply(session, inbox.closeAndDrain(session.id)), reason: "cancelled" } as RunTurnResult),
        );
      }),
    createEphemeralSession: (meta: FusionWorkerMeta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
    emitEvent: () => {},
    workingDir: "/repo",
    steerWorker: (sessionId, text) => inbox.push(sessionId, text),
    liveWorkers: live,
  };
  const sessionOf = (taskId: string): string => sessionByTask.get(taskId) ?? "";
  return {
    deps,
    readBy: (taskId: string) => read.get(sessionOf(taskId)) ?? [],
    stepBoundary: (taskId: string) => boundaries.get(sessionOf(taskId))?.(),
    finish: (taskId: string) => finishers.get(sessionOf(taskId))?.(),
  };
}

const TWO: DelegateTask[] = [
  { id: "ui", title: "UI", instructions: "build the form" },
  { id: "api", title: "API", instructions: "build the endpoint" },
];

describe("steering one fusion worker (ATO-568)", () => {
  it("delivers the note to that worker alone, at its next step boundary", async () => {
    const inbox = new SteeringInbox();
    const live = new FusionLiveWorkers();
    const h = inboxHarness(inbox, live);
    const run = runWorkerTasks(h.deps, {
      ...BASE,
      maxWorkers: 2,
      tasks: TWO,
      signal: new AbortController().signal,
    });
    await flush();
    expect(live.running("s-parent").sort()).toEqual(["api", "ui"]);

    expect(live.steer("s-parent", "ui", "  reuse the existing Button  ")).toBe(true);
    // Not read until the worker reaches a step boundary.
    expect(h.readBy("ui")).toEqual([]);
    h.stepBoundary("ui");
    h.stepBoundary("api");
    expect(h.readBy("ui")).toEqual([formatPersonSteer("reuse the existing Button")]);
    expect(h.readBy("api")).toEqual([]);

    h.finish("ui");
    h.finish("api");
    const rows = await run;
    const ui = rows.find((r) => r.id === "ui");
    const api = rows.find((r) => r.id === "api");
    expect(ui!.notes).toContain("the person sent this worker 1 note while it ran");
    expect(api!.notes ?? []).not.toContainEqual(expect.stringMatching(/the person sent/));
  });

  it("is addressed by the parent session: another session's id reaches nothing", async () => {
    const inbox = new SteeringInbox();
    const live = new FusionLiveWorkers();
    const h = inboxHarness(inbox, live);
    const run = runWorkerTasks(h.deps, {
      ...BASE,
      maxWorkers: 1,
      tasks: [TWO[0]!],
      signal: new AbortController().signal,
    });
    await flush();
    expect(live.steer("s-other", "ui", "hello")).toBe(false);
    expect(live.steer("s-parent", "missing", "hello")).toBe(false);
    expect(live.steer("s-parent", "ui", "   ")).toBe(false);
    h.stepBoundary("ui");
    expect(h.readBy("ui")).toEqual([]);
    h.finish("ui");
    await run;
    // Gone with its turn: a late note is refused, not stranded.
    expect(live.steer("s-parent", "ui", "too late")).toBe(false);
    expect(live.running("s-parent")).toEqual([]);
  });

  it("says on the row when a note arrived after the worker's last step", async () => {
    const inbox = new SteeringInbox();
    const live = new FusionLiveWorkers();
    const h = inboxHarness(inbox, live);
    const run = runWorkerTasks(h.deps, {
      ...BASE,
      maxWorkers: 1,
      tasks: [TWO[0]!],
      signal: new AbortController().signal,
    });
    await flush();
    expect(live.steer("s-parent", "ui", "first")).toBe(true);
    h.stepBoundary("ui");
    expect(live.steer("s-parent", "ui", "second")).toBe(true);
    // The turn ends before another boundary: "second" comes back unread.
    h.finish("ui");
    const [row] = await run;
    expect(row!.notes).toContain(
      "the person sent this worker 2 notes while it ran; 1 arrived after its last step and was not read",
    );
  });

  it("still stops one worker without touching its sibling", async () => {
    const inbox = new SteeringInbox();
    const live = new FusionLiveWorkers();
    const h = inboxHarness(inbox, live);
    const run = runWorkerTasks(h.deps, {
      ...BASE,
      maxWorkers: 2,
      tasks: TWO,
      signal: new AbortController().signal,
    });
    await flush();
    expect(live.stop("s-parent", "api")).toBe(true);
    await flush();
    expect(live.running("s-parent")).toEqual(["ui"]);
    expect(live.steer("s-parent", "ui", "carry on")).toBe(true);
    h.finish("ui");
    const rows = await run;
    expect(rows.find((r) => r.id === "api")!.status).toBe("cancelled");
    expect(rows.find((r) => r.id === "ui")!.status).not.toBe("cancelled");
  });
});

describe("FusionLiveWorkers.steer", () => {
  it("routes by parent session and task id, and refuses blank text before asking the worker", () => {
    const live = new FusionLiveWorkers();
    const got: string[] = [];
    const controls = (name: string): LiveWorkerControls => ({
      stop: () => {},
      escalate: async () => "",
      steer: (text) => {
        got.push(`${name}:${text}`);
        return true;
      },
    });
    live.register("s1", "t", controls("s1/t"));
    live.register("s2", "t", controls("s2/t"));
    expect(live.steer("s1", "t", "go left")).toBe(true);
    expect(live.steer("s2", "t", "go right")).toBe(true);
    expect(live.steer("s1", "t", "\n\t ")).toBe(false);
    expect(live.steer("s3", "t", "nobody")).toBe(false);
    expect(got).toEqual(["s1/t:go left", "s2/t:go right"]);
    expect(live.isRunning("s1", "t")).toBe(true);
    expect(live.isRunning("s1", "x")).toBe(false);
  });

  it("passes the worker's own refusal through", () => {
    const live = new FusionLiveWorkers();
    live.register("s1", "t", {
      stop: () => {},
      escalate: async () => "",
      steer: () => false,
    });
    expect(live.steer("s1", "t", "inbox full")).toBe(false);
  });
});

/**
 * A worker turn that THROWS hands back no `undelivered` list: the loop
 * drains the inbox in its own `finally` and only logs it. The row must
 * still say the person's note was not read (ATO-1269).
 */
describe("a note to a worker whose turn throws (ATO-1269)", () => {
  function throwingHarness(inbox: SteeringInbox, live: FusionLiveWorkers) {
    let minted = 0;
    let boundary: (() => void) | undefined;
    let explode: ((error: Error) => void) | undefined;
    const deps: WorkerRunnerDeps = {
      runTurn: (session: SessionState, _message: string, options: TurnOptions) =>
        new Promise<RunTurnResult>((_resolve, reject) => {
          inbox.open(session.id);
          // A step boundary as `AgentLoop` runs it: drain, and announce
          // each note folded into the step.
          boundary = () => {
            for (const text of inbox.drain(session.id)) {
              options.eventHook?.({ type: "steer_applied", text, stepIndex: 0 });
            }
          };
          explode = (error) => {
            // The loop's `finally` on the throw path: drained, not returned.
            inbox.closeAndDrain(session.id);
            reject(error);
          };
        }),
      createEphemeralSession: (meta: FusionWorkerMeta) => {
        minted += 1;
        return createEmptySessionState({
          id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
          workingDir: "/repo",
          metadata: { fusionWorker: { ...meta } },
        });
      },
      approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
      emitEvent: () => {},
      workingDir: "/repo",
      steerWorker: (sessionId, text) => inbox.push(sessionId, text),
      liveWorkers: live,
    };
    return {
      deps,
      stepBoundary: () => boundary?.(),
      explode: (error: Error) => explode?.(error),
    };
  }

  it("counts a note the worker never reached as not read", async () => {
    const inbox = new SteeringInbox();
    const live = new FusionLiveWorkers();
    const h = throwingHarness(inbox, live);
    const run = runWorkerTasks(h.deps, {
      ...BASE,
      maxWorkers: 1,
      tasks: [TWO[0]!],
      signal: new AbortController().signal,
    });
    await flush();
    expect(live.steer("s-parent", "ui", "use the old API")).toBe(true);
    h.explode(new Error("socket hang up"));
    const [row] = await run;
    expect(row!.status).toBe("failed");
    expect(row!.notes).toContain(
      "the person sent this worker 1 note while it ran; 1 arrived after its last step and was not read",
    );
  });

  it("does not count a note the worker read before the throw", async () => {
    const inbox = new SteeringInbox();
    const live = new FusionLiveWorkers();
    const h = throwingHarness(inbox, live);
    const run = runWorkerTasks(h.deps, {
      ...BASE,
      maxWorkers: 1,
      tasks: [TWO[0]!],
      signal: new AbortController().signal,
    });
    await flush();
    expect(live.steer("s-parent", "ui", "first")).toBe(true);
    h.stepBoundary();
    expect(live.steer("s-parent", "ui", "second")).toBe(true);
    h.explode(new Error("socket hang up"));
    const [row] = await run;
    expect(row!.notes).toContain(
      "the person sent this worker 2 notes while it ran; 1 arrived after its last step and was not read",
    );
  });
});
