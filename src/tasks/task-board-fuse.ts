import type { BoardEntry, BoardPatch } from "./task-board-lanes.js";
import type { BoardComment, BoardCommentInput } from "./task-board-comments.js";
import type { TaskRunRecord } from "./task-run-log.js";
import type { TaskRecord } from "./task-types.js";

/**
 * The board's failure fuse (ATO-2497), after the Hermes kanban
 * dispatcher (`agent/kanban_turn_recovery.py`): a card whose last runs
 * all failed stops being retried and goes to Blocked with a comment
 * saying why, so a broken task does not burn attempts unattended. Three,
 * the queue's default `tasks.maxAttempts`: with that default a one-shot
 * task fails for good on its third failure anyway; the fuse is what
 * stops a task given more attempts.
 */
export const BOARD_FAILURE_FUSE_RUNS = 3;

const FAILED_OUTCOMES: ReadonlySet<string> = new Set(["failed", "retry", "blocked"]);

/**
 * How many of the task's most recent runs failed in a row. `runs` is
 * newest first, as `TaskStore.listRuns` gives them; an interrupted run
 * (the agent quitting, a stop from the chat) ends the streak, since
 * nothing went wrong with the task.
 */
export function failedRunStreak(runs: readonly TaskRunRecord[], since: number | null = null): number {
  let streak = 0;
  for (const run of runs) {
    // A run from before the fuse last tripped was already counted then:
    // a person running the task again starts a fresh streak.
    if (since !== null && run.startedAt <= since) break;
    if (run.outcome === null || !FAILED_OUTCOMES.has(run.outcome)) break;
    streak += 1;
  }
  return streak;
}

/** The narrow store surface the fuse and the hold use. */
export interface BoardFuseStore {
  listRuns(taskId: string, limit?: number): TaskRunRecord[];
  boardEntry(id: string): BoardEntry | null;
  updateBoardCard(id: string, patch: BoardPatch, now?: number): unknown;
  addBoardComment(id: string, input: BoardCommentInput, now?: number): BoardComment | null;
  listBoardComments(id: string, limit?: number): BoardComment[];
  pause(id: string, now?: number): TaskRecord | null;
  readonly boardUnavailable: string | null;
}

/**
 * After a failed run put `task` back for another attempt: when its last
 * `BOARD_FAILURE_FUSE_RUNS` runs all failed, move its card to Blocked,
 * say why in a comment, and pause the task so it is not tried again
 * until a person runs it or resumes it. Returns the paused record, or
 * `task` unchanged when the fuse does not trip (or the board is off:
 * nowhere to show why, so the queue retries as before).
 */
export function tripBoardFuse(
  store: BoardFuseStore,
  task: TaskRecord,
  now: number = Date.now(),
): TaskRecord {
  if (task.status !== "pending" || store.boardUnavailable !== null) return task;
  const lastTrip = store.listBoardComments(task.id).find((c) => c.kind === "fuse");
  const streak = failedRunStreak(
    store.listRuns(task.id, BOARD_FAILURE_FUSE_RUNS),
    lastTrip?.createdAt ?? null,
  );
  if (streak < BOARD_FAILURE_FUSE_RUNS) return task;
  store.updateBoardCard(task.id, { lane: "blocked" }, now);
  // The error goes on its own line: the board shows it behind "Details".
  const reason = task.lastError ? `\nLast error: ${task.lastError}` : "";
  store.addBoardComment(
    task.id,
    {
      author: "system",
      kind: "fuse",
      text: `Stopped after ${streak} failed runs in a row.${reason}`.slice(0, 2_000),
    },
    now,
  );
  return pauseQuietly(store, task);
}

/**
 * After a run that leaves `task` waiting again (a retry, a recurring
 * task armed for its next firing): when the agent blocked its card
 * during that run (`tasks.block`), pause it, so a blocked card does not
 * fire again until a person moves it on. `runStartedAt` is when the
 * run began; a block from before it was already followed by this run.
 */
export function holdBlockedCard(
  store: BoardFuseStore,
  task: TaskRecord,
  runStartedAt: number | null,
): TaskRecord {
  if (task.status !== "pending" || runStartedAt === null) return task;
  const entry = store.boardEntry(task.id);
  if (!entry || entry.lane !== "blocked" || entry.laneSetAt === null) return task;
  if (entry.laneSetAt < runStartedAt) return task;
  return pauseQuietly(store, task);
}

function pauseQuietly(store: BoardFuseStore, task: TaskRecord): TaskRecord {
  try {
    return store.pause(task.id) ?? task;
  } catch {
    // Claimed or cancelled meanwhile: that newer state stands.
    return task;
  }
}
