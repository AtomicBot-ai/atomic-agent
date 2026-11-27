import type { TaskRecord, TaskStatus } from "./task-types.js";

/**
 * The task board (ATO-2257): every task is a card in one of five lanes,
 * the way Vibe Kanban and the Hermes/OpenClaw workboards lay agent work
 * out. The lane is a view over the queue, not a second status machine:
 * moving a card never claims, runs, pauses or ends the task. Pure; the
 * stored part lives in `task-board.ts`.
 */
export const BOARD_LANES = ["todo", "doing", "review", "blocked", "done"] as const;
export type BoardLane = (typeof BOARD_LANES)[number];

/** Longest note a card keeps (a person's or an agent's comment). */
export const BOARD_NOTE_MAX_LENGTH = 2_000;
/**
 * An assignee is an agent profile name; the same rule as
 * `agent-profiles/agent-profile.ts` (`NAME_PATTERN`), kept here so the
 * queue does not import the profiles layer.
 */
export const BOARD_ASSIGNEE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** What the board stores for one task; every field optional. */
export interface BoardEntry {
  taskId: string;
  /** The lane a person or agent put the card in, or `null` (follow the status). */
  lane: BoardLane | null;
  /** When `lane` was last set (see `laneForCard`), or `null`. */
  laneSetAt: number | null;
  note: string | null;
  assignee: string | null;
  updatedAt: number;
}

/** A patch to a card. `undefined` leaves a field, `null` clears it. */
export interface BoardPatch {
  lane?: BoardLane | null;
  note?: string | null;
  assignee?: string | null;
}

export interface BoardCard {
  task: TaskRecord;
  lane: BoardLane;
  /** `board`: someone put it there; `status`: derived from the task's status. */
  laneSource: "board" | "status";
  note: string | null;
  assignee: string | null;
  boardUpdatedAt: number | null;
}

export class BoardValidationError extends Error {
  constructor(
    public readonly field: "lane" | "note" | "assignee",
    message: string,
  ) {
    super(message);
    this.name = "BoardValidationError";
  }
}

export function isBoardLane(value: unknown): value is BoardLane {
  return typeof value === "string" && (BOARD_LANES as readonly string[]).includes(value);
}

/** The lane a task sits in when nobody has moved its card. */
export function laneForStatus(status: TaskStatus): BoardLane {
  switch (status) {
    case "pending":
    case "paused":
      return "todo";
    case "running":
      return "doing";
    case "failed":
    case "blocked":
      return "blocked";
    case "completed":
    case "cancelled":
      return "done";
  }
}

/**
 * The lane a card shows. A lane someone set wins until the task starts a
 * new run after the move: a card put in "review" during or after a run
 * stays there when that run completes, while a "done" card that is run
 * again (by hand, a retry or its next firing) follows the status again,
 * so a fresh run is never hidden in an old lane. Editing only the note
 * or the assignee does not re-pin the lane.
 */
export function laneForCard(task: TaskRecord, entry: BoardEntry | undefined): {
  lane: BoardLane;
  laneSource: "board" | "status";
} {
  if (entry && entry.lane !== null && entry.laneSetAt !== null) {
    const startedAfterMove = task.startedAt !== null && task.startedAt > entry.laneSetAt;
    if (!startedAfterMove) return { lane: entry.lane, laneSource: "board" };
  }
  return { lane: laneForStatus(task.status), laneSource: "status" };
}

/**
 * Check a patch from HTTP or a tool. Strings are trimmed; an empty note
 * or assignee clears it. Unknown keys are ignored by the caller.
 */
export function validateBoardPatch(raw: {
  lane?: unknown;
  note?: unknown;
  assignee?: unknown;
}): BoardPatch {
  const patch: BoardPatch = {};
  const rawLane = raw.lane;
  if (rawLane !== undefined) {
    if (rawLane === null) {
      patch.lane = null;
    } else if (isBoardLane(rawLane)) {
      patch.lane = rawLane;
    } else {
      throw new BoardValidationError("lane", `lane must be one of: ${BOARD_LANES.join(", ")}`);
    }
  }
  const rawNote = raw.note;
  if (rawNote !== undefined) {
    if (rawNote !== null && typeof rawNote !== "string") {
      throw new BoardValidationError("note", "note must be a string or null");
    }
    const note = typeof rawNote === "string" ? rawNote.trim() : "";
    if (note.length > BOARD_NOTE_MAX_LENGTH) {
      throw new BoardValidationError("note", `note is longer than ${BOARD_NOTE_MAX_LENGTH} characters`);
    }
    patch.note = note.length > 0 ? note : null;
  }
  const rawAssignee = raw.assignee;
  if (rawAssignee !== undefined) {
    if (rawAssignee !== null && typeof rawAssignee !== "string") {
      throw new BoardValidationError("assignee", "assignee must be a profile name or null");
    }
    const assignee = typeof rawAssignee === "string" ? rawAssignee.trim() : "";
    if (assignee.length > 0 && !BOARD_ASSIGNEE_PATTERN.test(assignee)) {
      throw new BoardValidationError(
        "assignee",
        "assignee must be a profile name (lowercase letters, digits, - and _)",
      );
    }
    patch.assignee = assignee.length > 0 ? assignee : null;
  }
  return patch;
}

/** Join tasks with their stored entries into cards, in the tasks' order. */
export function buildBoardCards(
  tasks: readonly TaskRecord[],
  entries: ReadonlyMap<string, BoardEntry>,
): BoardCard[] {
  return tasks.map((task) => {
    const entry = entries.get(task.id);
    const { lane, laneSource } = laneForCard(task, entry);
    return {
      task,
      lane,
      laneSource,
      note: entry?.note ?? null,
      assignee: entry?.assignee ?? null,
      boardUpdatedAt: entry?.updatedAt ?? null,
    };
  });
}

/** Cards grouped by lane; every lane is present, in board order. */
export function groupCardsByLane(cards: readonly BoardCard[]): Record<BoardLane, BoardCard[]> {
  const lanes = Object.fromEntries(BOARD_LANES.map((lane) => [lane, [] as BoardCard[]])) as Record<
    BoardLane,
    BoardCard[]
  >;
  for (const card of cards) lanes[card.lane].push(card);
  return lanes;
}
