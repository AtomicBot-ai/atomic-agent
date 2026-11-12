import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { userTurn } from "../session/conversation-turn.js";
import { INTERRUPTED_TURN_RESUME_NOTE } from "../session/interrupted-chat-turn.js";
import { SessionStore } from "../session/session-store.js";
import { createEmptySessionState, recordTurn } from "../session/session-state.js";
import type { TurnOwnerProbe } from "../session/turn-owner.js";
import type { TurnProgress } from "../session/turn-progress.js";
import { createInterruptedTurns } from "./interrupted-turns.js";

/**
 * The runtime entry point behind `/resume` (ATO-448), on a real store:
 * a chat turn the boot sweep ended is offered once, and nothing else is.
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

function marker(extra: Partial<TurnProgress> = {}): TurnProgress {
  return {
    stepsDone: 0,
    lastStepIndex: -1,
    request: "push the release branch",
    options: { interactive: true },
    resumes: 0,
    startedAt: 1_000,
    updatedAt: 1_000,
    ...extra,
  };
}

describe("createInterruptedTurns", () => {
  let tmp: string;
  let file: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-interrupted-"));
    file = join(tmp, "sessions.sqlite");
    store = new SessionStore({ dbFile: file, turnOwnerProbe: probe(100) });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A turn started on `id` and left running when its process died. */
  function cutOffByRestart(id: string, progress: TurnProgress = marker()): void {
    const state = createEmptySessionState({ id, workingDir: "/w" });
    store.save(state);
    store.beginTurn(id, 1_000, progress);
    store.checkpointTurn(
      { ...recordTurn(state, userTurn(progress.request)), status: "running" },
      { ...progress, stepsDone: 1, lastStepIndex: 0 },
    );
    store.close();
    // The next start: another pid, the first one gone.
    store = new SessionStore({ dbFile: file, turnOwnerProbe: probe(200) });
    expect(store.recoverInterruptedTurns({ isOwnerGone: () => true })).toEqual([id]);
  }

  it("offers a chat turn a restart cut off, with the note and the request", () => {
    cutOffByRestart("s1");
    const turns = createInterruptedTurns(store);
    expect(turns.pending("s1")).toMatchObject({
      request: "push the release branch",
      stepsDone: 1,
    });
    const message = turns.resumeMessage("s1");
    expect(message).toContain(INTERRUPTED_TURN_RESUME_NOTE);
    expect(message?.endsWith("push the release branch")).toBe(true);
  });

  it("can be resumed only once", () => {
    cutOffByRestart("s2");
    const turns = createInterruptedTurns(store);
    expect(turns.resumeMessage("s2")).not.toBeNull();
    // Recorded as resumed: nothing is offered any more.
    expect(turns.pending("s2")).toBeNull();
    expect(turns.resumeMessage("s2")).toBeNull();
    expect(store.readTurnProgress("s2")).toBeNull();
  });

  it("offers nothing when the last turn ended on its own or a person stopped it", () => {
    const done = createEmptySessionState({ id: "done", workingDir: "/w" });
    store.save(done);
    store.beginTurn("done", 1_000, marker());
    store.finishTurn({ ...recordTurn(done, userTurn("hi")), status: "pending" });

    const stopped = createEmptySessionState({ id: "stopped", workingDir: "/w" });
    store.save(stopped);
    store.beginTurn("stopped", 1_000, marker());
    store.finishTurn({ ...recordTurn(stopped, userTurn("hi")), status: "cancelled" });

    const turns = createInterruptedTurns(store);
    expect(turns.pending("done")).toBeNull();
    // The marker is kept for a stopped turn, but a stop is the person's.
    expect(store.readTurnProgress("stopped")).not.toBeNull();
    expect(turns.pending("stopped")).toBeNull();
    expect(turns.resumeMessage("stopped")).toBeNull();
    expect(turns.pending("missing")).toBeNull();
  });

  it("leaves a durable task's interrupted turn to the task runner", () => {
    cutOffByRestart("task-session", marker({ options: { taskId: "t-1" } }));
    const turns = createInterruptedTurns(store);
    expect(turns.pending("task-session")).toBeNull();
    expect(turns.resumeMessage("task-session")).toBeNull();
    expect(store.readTurnProgress("task-session")).not.toBeNull();
  });
});
