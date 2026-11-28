import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore } from "./task-store.js";
import {
  BOARD_FAILURE_FUSE_RUNS,
  failedRunStreak,
  holdBlockedCard,
  tripBoardFuse,
} from "./task-board-fuse.js";
import type { TaskRunRecord } from "./task-run-log.js";

function run(outcome: TaskRunRecord["outcome"], startedAt: number): TaskRunRecord {
  return {
    id: startedAt,
    taskId: "t",
    attempt: 1,
    sessionId: "s",
    startedAt,
    endedAt: startedAt + 1,
    outcome,
    error: null,
    errorCategory: null,
  };
}

describe("failedRunStreak", () => {
  it("counts failed runs from the newest until another outcome", () => {
    expect(failedRunStreak([run("retry", 30), run("retry", 20), run("completed", 10)])).toBe(2);
    expect(failedRunStreak([run("failed", 30), run("blocked", 20), run("retry", 10)])).toBe(3);
    // An interrupted run is no failure of the task.
    expect(failedRunStreak([run("retry", 30), run("interrupted", 20), run("retry", 10)])).toBe(1);
    expect(failedRunStreak([run(null, 30)])).toBe(0);
  });

  it("starts afresh after the fuse last tripped", () => {
    expect(failedRunStreak([run("retry", 30), run("retry", 20), run("retry", 10)], 20)).toBe(1);
  });
});

/** ATO-2497: a card that keeps failing goes to Blocked and stops being retried. */
describe("tripBoardFuse and holdBlockedCard", () => {
  let tmp: string;
  let store: TaskStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-board-fuse-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const failOnce = (id: string, at: number) => {
    store.markRunning(id, at);
    return store.markRetry(id, { category: "transport", message: "server went away" }, at + 5);
  };

  it("leaves a task that failed fewer times than the fuse to be retried", () => {
    const t = store.create({ sessionId: "s", userMessage: "x", origin: "cli", maxAttempts: 10 });
    let record = failOnce(t.id, 1_000);
    for (let i = 1; i < BOARD_FAILURE_FUSE_RUNS - 1; i += 1) record = failOnce(t.id, 1_000 + i * 100);
    expect(tripBoardFuse(store, record, 5_000).status).toBe("pending");
    expect(store.boardEntry(t.id)).toBeNull();
  });

  it("pauses the task in Blocked with a comment once the last runs all failed", () => {
    const t = store.create({ sessionId: "s", userMessage: "x", origin: "cli", maxAttempts: 10 });
    let record = failOnce(t.id, 1_000);
    for (let i = 1; i < BOARD_FAILURE_FUSE_RUNS; i += 1) record = failOnce(t.id, 1_000 + i * 100);
    const tripped = tripBoardFuse(store, record, 5_000);
    expect(tripped.status).toBe("paused");
    const card = store.boardCards().find((c) => c.task.id === t.id);
    expect(card).toMatchObject({ lane: "blocked", laneSource: "board" });
    const [comment] = store.listBoardComments(t.id);
    expect(comment).toMatchObject({ author: "system", kind: "fuse" });
    expect(comment?.text).toContain(`${BOARD_FAILURE_FUSE_RUNS} failed runs in a row`);
    expect(comment?.text).toContain("server went away");
  });

  it("needs a fresh streak after a person runs the task again", () => {
    const t = store.create({ sessionId: "s", userMessage: "x", origin: "cli", maxAttempts: 10 });
    let record = failOnce(t.id, 1_000);
    for (let i = 1; i < BOARD_FAILURE_FUSE_RUNS; i += 1) record = failOnce(t.id, 1_000 + i * 100);
    tripBoardFuse(store, record, 5_000);
    // "Run now" on the paused card, and it fails once more.
    store.markRunning(t.id, 6_000, { fromPaused: true });
    const again = store.markRetry(t.id, { category: "transport", message: "again" }, 6_005);
    expect(tripBoardFuse(store, again, 6_010).status).toBe("pending");
  });

  it("holds a card the agent blocked during the run that just ended", () => {
    const t = store.create({ sessionId: "s", userMessage: "x", origin: "cli", maxAttempts: 10 });
    store.markRunning(t.id, 1_000);
    store.updateBoardCard(t.id, { lane: "blocked" }, 1_500);
    const retried = store.markRetry(t.id, { category: "transport", message: "x" }, 2_000);
    expect(holdBlockedCard(store, retried, 1_000).status).toBe("paused");
  });

  it("does not hold a card blocked before the run, which that run already followed", () => {
    const t = store.create({ sessionId: "s", userMessage: "x", origin: "cli", maxAttempts: 10 });
    store.updateBoardCard(t.id, { lane: "blocked" }, 500);
    store.markRunning(t.id, 1_000);
    const retried = store.markRetry(t.id, { category: "transport", message: "x" }, 2_000);
    expect(holdBlockedCard(store, retried, 1_000).status).toBe("pending");
  });
});
