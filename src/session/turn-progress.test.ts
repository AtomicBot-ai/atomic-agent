import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assistantReplyTurn, userTurn } from "./conversation-turn.js";
import { SessionStore } from "./session-store.js";
import {
  createEmptySessionState,
  recordTurn,
  type SessionState,
} from "./session-state.js";
import type { TurnOwnerProbe } from "./turn-owner.js";
import {
  parseTurnProgress,
  serializeTurnProgress,
  type TurnProgress,
} from "./turn-progress.js";

/**
 * Per-step checkpoints (ATO-1109): a turn's completed steps reach the
 * store as it goes, with a progress marker, so a crash mid-turn loses at
 * most the step in flight and the turn can be continued.
 */

function probe(pid: number): TurnOwnerProbe {
  return {
    pid,
    host: "darwin",
    hostUptime: () => 50_000,
    isAlive: () => true,
    processStartOf: () => null,
  };
}

function progress(extra: Partial<TurnProgress> = {}): TurnProgress {
  return {
    stepsDone: 0,
    lastStepIndex: -1,
    request: "rename every file",
    options: { taskId: "task-1", maxSteps: 40 },
    resumes: 0,
    startedAt: 1_000,
    updatedAt: 1_000,
    ...extra,
  };
}

describe("turn progress markers", () => {
  it("round-trips and drops what does not parse", () => {
    const marker = progress({ stepsDone: 3, lastStepIndex: 2, resumes: 1 });
    expect(parseTurnProgress(serializeTurnProgress(marker))).toEqual(marker);
    expect(parseTurnProgress(null)).toBeNull();
    expect(parseTurnProgress("not json")).toBeNull();
    expect(parseTurnProgress(JSON.stringify({ stepsDone: 1 }))).toBeNull();
    expect(
      parseTurnProgress(
        JSON.stringify({ request: "x", stepsDone: -4, resumes: "2", options: { maxSteps: 0 } }),
      ),
    ).toMatchObject({ stepsDone: 0, resumes: 0, options: {} });
  });
});

describe("SessionStore turn checkpoints", () => {
  let tmp: string;
  let file: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-progress-"));
    file = join(tmp, "sessions.sqlite");
    store = new SessionStore({ dbFile: file, turnOwnerProbe: probe(100) });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function seed(id: string): SessionState {
    const state = createEmptySessionState({ id, workingDir: "/w" });
    store.save(state);
    return state;
  }

  function afterSteps(state: SessionState, steps: number): SessionState {
    let next = recordTurn(state, userTurn("rename every file"));
    for (let i = 0; i < steps; i += 1) {
      next = recordTurn(next, assistantReplyTurn(`step ${i}`));
    }
    return { ...next, status: "running" };
  }

  it("writes each completed step's transcript and marker while the turn runs", () => {
    const state = seed("s1");
    store.beginTurn("s1", 1_000, progress());
    expect(store.readTurnProgress("s1")).toEqual(progress());

    expect(
      store.checkpointTurn(
        afterSteps(state, 1),
        progress({ stepsDone: 1, lastStepIndex: 0, updatedAt: 2_000 }),
      ),
    ).toBe(true);
    expect(
      store.checkpointTurn(
        afterSteps(state, 2),
        progress({ stepsDone: 2, lastStepIndex: 1, updatedAt: 3_000 }),
      ),
    ).toBe(true);

    // A crash now loses nothing that was checkpointed.
    const loaded = store.load("s1");
    expect(loaded?.status).toBe("running");
    expect(loaded?.turns).toHaveLength(3);
    expect(store.readTurnProgress("s1")).toMatchObject({
      stepsDone: 2,
      lastStepIndex: 1,
    });
  });

  it("keeps a title the row got while the turn ran", () => {
    const state = seed("named");
    store.beginTurn("named", 1_000, progress());
    // Renamed mid-turn: the loop's copy was read before, without it.
    store.renameSession("named", "Operator title", 1_500);
    store.checkpointTurn(
      afterSteps(state, 1),
      progress({ stepsDone: 1, lastStepIndex: 0 }),
    );
    expect(store.load("named")?.metadata.title).toBe("Operator title");
    store.finishTurn({ ...afterSteps(state, 1), status: "pending" });
    expect(store.load("named")?.metadata.title).toBe("Operator title");
  });

  it("does not checkpoint a turn it did not mark", () => {
    const state = seed("s2");
    expect(store.checkpointTurn(afterSteps(state, 1), progress())).toBe(false);
    expect(store.load("s2")?.turns).toHaveLength(0);
    expect(store.readTurnProgress("s2")).toBeNull();
  });

  it("clears the marker when the turn ends on its own, keeps it when it is stopped", () => {
    const done = seed("done");
    store.beginTurn("done", 1_000, progress());
    store.finishTurn({ ...afterSteps(done, 1), status: "pending" });
    expect(store.readTurnProgress("done")).toBeNull();

    const stopped = seed("stopped");
    store.beginTurn("stopped", 1_000, progress());
    store.finishTurn({ ...afterSteps(stopped, 1), status: "cancelled" });
    expect(store.readTurnProgress("stopped")).not.toBeNull();

    const failed = seed("failed");
    store.beginTurn("failed", 1_000, progress());
    store.releaseTurn("failed", { status: "failed", lastError: "boom" });
    expect(store.readTurnProgress("failed")).toBeNull();
  });

  it("keeps the marker of a turn whose process died, through the boot sweep", () => {
    const state = seed("crashed");
    store.beginTurn("crashed", 1_000, progress());
    store.checkpointTurn(
      afterSteps(state, 3),
      progress({ stepsDone: 3, lastStepIndex: 2 }),
    );
    store.close();

    // The next process: another pid, and the first one is gone.
    store = new SessionStore({ dbFile: file, turnOwnerProbe: probe(200) });
    expect(store.recoverInterruptedTurns({ isOwnerGone: () => true })).toEqual([
      "crashed",
    ]);
    const loaded = store.load("crashed");
    expect(loaded?.status).toBe("cancelled");
    expect(loaded?.turns).toHaveLength(4);
    expect(store.readTurnProgress("crashed")).toMatchObject({
      stepsDone: 3,
      options: { taskId: "task-1" },
    });
  });

  it("a new turn replaces the marker an interrupted one left", () => {
    seed("s3");
    store.beginTurn("s3", 1_000, progress({ stepsDone: 5 }));
    store.releaseOwnTurns({ status: "cancelled" });
    expect(store.readTurnProgress("s3")).toMatchObject({ stepsDone: 5 });
    store.beginTurn("s3", 2_000);
    expect(store.readTurnProgress("s3")).toBeNull();
    store.beginTurn("s3", 3_000, progress({ resumes: 1 }));
    expect(store.readTurnProgress("s3")).toMatchObject({ resumes: 1, stepsDone: 0 });
    store.clearTurnProgress("s3");
    expect(store.readTurnProgress("s3")).toBeNull();
  });
});
