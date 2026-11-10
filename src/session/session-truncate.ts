import { compactionBoundaryHash } from "./session-compaction.js";
import type { SessionState } from "./session-state.js";
import { LIVE_SESSION_STATUSES } from "./session-retention.js";

/**
 * Cutting a chat back to an earlier point (ATO-1297).
 *
 * The transcript is otherwise append-only, and several fields remember a
 * position in it: the recorded macro-turn boundaries, the packer's held
 * cut, the background summary's watermark, the cloud context's mirror of
 * the transcript, the context gauge of the last turn. Dropping rows
 * without fixing those leaves the next turn reading positions that no
 * longer exist (the cloud context throws on its next extension, the
 * packer holds a start past the end). This module is the one place that
 * knows the whole list.
 *
 * No policy here: {@link truncateSessionAt} cuts anywhere, tools or not,
 * so `/rewind` (ATO-1057) and editing a sent message (ATO-1058) can use
 * it too. What may be undone is decided by {@link planLastTurnRollback}.
 */

export interface TruncateSessionResult {
  state: SessionState;
  /**
   * The compaction checkpoint covers rows that were cut. It is left on
   * the state untouched: its summary speaks for rows that are gone, so
   * the caller decides (refuse, or drop the checkpoint and pay a full
   * re-read).
   */
  compactionCovered: boolean;
}

/**
 * The session as it was with only `turns[0, index)`. `index` is clamped
 * to `[0, turns.length]`; cutting at the end returns the state as is.
 */
export function truncateSessionAt(
  state: SessionState,
  index: number,
): TruncateSessionResult {
  const length = state.turns.length;
  const cut = Math.max(0, Math.min(length, Math.floor(index)));
  if (cut >= length) return { state, compactionCovered: false };

  const removed = state.turns.slice(cut);
  const recorded = state.macroTurnStarts;
  // Each recorded value is where a closed turn ended (= the next opens),
  // so the closed turns removed are the values past the cut. A turn whose
  // end was never recorded (the process died before it closed) was never
  // counted either. Sessions written before the field count the prompts
  // that were cut instead: each one opened a turn.
  const closedRemoved =
    recorded !== undefined
      ? recorded.filter((value) => value > cut).length
      : removed.filter((turn) => turn.kind === "user" && turn.steered !== true)
          .length;

  const next: SessionState = {
    ...state,
    turns: state.turns.slice(0, cut),
    turnCount: Math.max(0, state.turnCount - closedRemoved),
    // What a chat waiting for its next message reads (a turn that ended
    // on a reply leaves `pending`; `completed` means `finish` closed the
    // task). The status the cut turn ended on goes with it.
    status: "pending",
    lastError: null,
    updatedAt: Date.now(),
  };
  if (recorded !== undefined) {
    next.macroTurnStarts = recorded.filter((value) => value <= cut);
  }
  if (
    next.conversationPackStart !== undefined &&
    next.conversationPackStart.index >= cut
  ) {
    delete next.conversationPackStart;
  }
  if (
    next.rollingSummary !== undefined &&
    next.rollingSummary.coveredThrough > cut
  ) {
    delete next.rollingSummary;
  }
  // The gauge is the last turn's prompt, and the last turn is gone.
  delete next.contextUsage;
  if (next.cloudContext !== undefined && next.cloudContext.turnsThrough > cut) {
    next.cloudContext = {
      ...next.cloudContext,
      turnsThrough: cut,
      boundaryHash: cut > 0 ? compactionBoundaryHash(next.turns[cut - 1]!) : null,
      entries: next.cloudContext.entries.filter((entry) => entry.through <= cut),
    };
  }
  return {
    state: next,
    compactionCovered:
      state.compaction !== undefined && state.compaction.coveredThrough > cut,
  };
}

/** Why the last turn cannot be taken back. */
export type LastTurnRollbackRefusal =
  /** No prompt to take back. */
  | "nothing_to_undo"
  /** A turn is running on the chat. */
  | "turn_in_progress"
  /** The turn ran tools: their effects stay, so a redo would not be one. */
  | "turn_has_tools"
  /** A message was folded into the turn while it ran. */
  | "turn_steered"
  /** A compaction checkpoint already summarises the turn. */
  | "turn_compacted"
  /** The rows after the prompt are not one plain answer. */
  | "turn_unrecognized"
  /** The last question is not the one the caller meant (`expectText`). */
  | "turn_mismatch";

export type LastTurnRollbackPlan =
  | {
      ok: true;
      /** Index of the prompt row; the state keeps `turns[0, start)`. */
      start: number;
      /** What the person typed, to send again. */
      text: string;
      state: SessionState;
    }
  | { ok: false; code: LastTurnRollbackRefusal };

/**
 * Take back the last turn when doing so changes nothing but the
 * transcript: a prompt answered by one reply, by a stop marker, or by
 * nothing at all (a provider error). Anything the turn did outside the
 * transcript (tool calls) or that the person added to it mid-way (a
 * steer) makes it refuse, because sending the prompt again would then
 * not be a fresh try of the same question.
 */
export interface LastTurnRollbackOptions {
  /**
   * The question the caller means to take back. When the stored last
   * question differs (a failed turn the agent never recorded, so its
   * last question is the one before), it refuses with `turn_mismatch`
   * rather than removing a turn the person did not point at. Compared
   * with surrounding whitespace trimmed.
   */
  expectText?: string;
}

export function planLastTurnRollback(
  state: SessionState,
  options: LastTurnRollbackOptions = {},
): LastTurnRollbackPlan {
  if (LIVE_SESSION_STATUSES.includes(state.status)) {
    return { ok: false, code: "turn_in_progress" };
  }
  const turns = state.turns;
  let start = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.kind === "user") {
      start = i;
      break;
    }
  }
  if (start < 0) return { ok: false, code: "nothing_to_undo" };
  const prompt = turns[start]!;
  if (prompt.kind !== "user") return { ok: false, code: "nothing_to_undo" };
  if (prompt.steered === true) return { ok: false, code: "turn_steered" };
  if (
    options.expectText !== undefined &&
    options.expectText.trim() !== prompt.text.trim()
  ) {
    return { ok: false, code: "turn_mismatch" };
  }

  const after = turns.slice(start + 1);
  if (
    after.some(
      (turn) =>
        turn.kind === "assistant_tool_call" ||
        turn.kind === "tool_result" ||
        (turn.kind === "assistant_reply" && turn.progressNote === true),
    )
  ) {
    return { ok: false, code: "turn_has_tools" };
  }
  if (after.length > 1) return { ok: false, code: "turn_unrecognized" };
  const reply = after[0];
  if (reply?.kind === "assistant_reply" && (reply.attachments?.length ?? 0) > 0) {
    // Files delivered with a reply were made by a tool.
    return { ok: false, code: "turn_has_tools" };
  }

  const { state: next, compactionCovered } = truncateSessionAt(state, start);
  if (compactionCovered) return { ok: false, code: "turn_compacted" };
  return { ok: true, start, text: prompt.text, state: next };
}
