import { compactionBoundaryHash } from "./session-compaction.js";
import { incrementTurnCount, type SessionState } from "./session-state.js";
import {
  countQuestions,
  isKeepableReply,
  isRecordFor,
  withPreviousReply,
  type PreviousReply,
} from "./session-previous-replies.js";
import { LIVE_SESSION_STATUSES } from "./session-retention.js";
import { foldStaleReplies } from "./session-message-branches.js";

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
  original: SessionState,
  index: number,
): TruncateSessionResult {
  const length = original.turns.length;
  const cut = Math.max(0, Math.min(length, Math.floor(index)));
  if (cut >= length) return { state: original, compactionCovered: false };
  // ATO-2470: answers kept for a question the chat has moved past become
  // versions of that answer before the cut decides what stays.
  const state = foldStaleReplies(original);

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
  // Earlier answers (ATO-864) belong to one question. They stay only when
  // that question is the next one the kept rows lead to (the cut is at it,
  // as a regenerate's is); a cut further back leaves them for nothing.
  if (
    next.previousReplies !== undefined &&
    countQuestions(next.turns) !== next.previousReplies.priorQuestions
  ) {
    delete next.previousReplies;
  }
  // Versions of a message (ATO-2470) stay for the questions the kept rows
  // reach and the next one; the ones past it belonged to the rows cut.
  if (next.messageBranches !== undefined) {
    const reach = countQuestions(next.turns);
    const kept = next.messageBranches.filter((branch) => branch.priorQuestions <= reach);
    if (kept.length > 0) next.messageBranches = kept;
    else delete next.messageBranches;
  }
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
  /**
   * The person stopped the turn. A stop can land while a tool batch runs,
   * and a local turn does not record the cancelled step, so the stored
   * tail shows no tool even when one ran: a stopped turn is never taken
   * back.
   */
  | "turn_stopped"
  /** The rows after the prompt are not one plain answer. */
  | "turn_unrecognized"
  /**
   * The last question is not the one the caller meant (`expectText`,
   * `expectPriorQuestions`, `expectUnanswered`).
   */
  | "turn_mismatch";

export type LastTurnRollbackPlan =
  | {
      ok: true;
      /** Index of the prompt row; the state keeps `turns[0, start)`. */
      start: number;
      /** What the person typed, to send again. */
      text: string;
      /**
       * The state with `turns[0, start)`. When the turn ended on a real
       * answer, that answer is kept in `previousReplies` (ATO-864) so the
       * person can go back to it if the new try fails or is worse.
       */
      state: SessionState;
      /** Earlier answers the question now has (0 when none was kept). */
      previousReplies: number;
    }
  | { ok: false; code: LastTurnRollbackRefusal };

/** What the caller expects the last turn to be. */
export interface LastTurnRollbackOptions {
  /**
   * The question the caller means to take back. When the stored last
   * question differs (a failed turn the agent never recorded, so its
   * last question is the one before), it refuses with `turn_mismatch`
   * rather than removing a turn the person did not point at. Compared
   * with surrounding whitespace trimmed.
   */
  expectText?: string;
  /**
   * How many questions (user rows that opened a turn, steers not counted)
   * come before the one the caller means. Text alone cannot tell two
   * questions apart ("continue", then a "continue" whose failed turn was
   * never stored); the position can. A different count refuses with
   * `turn_mismatch`.
   */
  expectPriorQuestions?: number;
  /**
   * The caller saw no answer to the question it means (its turn failed
   * on screen). A stored last question that has a reply is then not that
   * question, whatever its text and position say, and it refuses with
   * `turn_mismatch` (ATO-1420). The position is counted by the client
   * from what it shows, and a client whose transcript was cleared, or
   * that counts wrong for any other reason, could otherwise line a failed
   * "continue" up with an earlier "continue" and remove its real answer.
   * Taking back a question that has no answer loses no answer, so the
   * opposite case (a reply on screen, none stored) is not checked.
   */
  expectUnanswered?: boolean;
}

/**
 * Take back the last turn when doing so changes nothing but the
 * transcript: a prompt answered by one reply, or by nothing at all (a
 * provider error). Anything the turn did outside the transcript (tool
 * calls), that the person added to it mid-way (a steer), or a stop
 * (which may have cut a tool batch the transcript does not show) makes
 * it refuse, because sending the prompt again would then not be a fresh
 * try of the same question.
 */

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
  if (options.expectPriorQuestions !== undefined) {
    const prior = turns
      .slice(0, start)
      .filter((turn) => turn.kind === "user" && turn.steered !== true).length;
    if (prior !== options.expectPriorQuestions) {
      return { ok: false, code: "turn_mismatch" };
    }
  }

  const after = turns.slice(start + 1);
  if (
    options.expectUnanswered === true &&
    after.some(
      (turn) =>
        turn.kind === "assistant_reply" &&
        turn.progressNote !== true &&
        turn.stopped !== true,
    )
  ) {
    return { ok: false, code: "turn_mismatch" };
  }
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
  if (after.some((turn) => turn.kind === "assistant_reply" && turn.stopped === true)) {
    return { ok: false, code: "turn_stopped" };
  }
  if (after.length > 1) return { ok: false, code: "turn_unrecognized" };
  const reply = after[0];
  if (reply?.kind === "assistant_reply" && (reply.attachments?.length ?? 0) > 0) {
    // Files delivered with a reply were made by a tool.
    return { ok: false, code: "turn_has_tools" };
  }
  if (reply?.kind === "assistant_reply" && reply.toolsRan === true) {
    // A failed turn whose tools ran (ATO-1476): the step that ran them
    // may never have been stored, so the tail shows no tool row, but
    // taking the turn back and sending it again would run them twice.
    return { ok: false, code: "turn_has_tools" };
  }

  const { state: cut, compactionCovered } = truncateSessionAt(state, start);
  if (compactionCovered) return { ok: false, code: "turn_compacted" };
  // Keep the answer being replaced (ATO-864), beside the transcript.
  const priorQuestions = countQuestions(turns.slice(0, start));
  const next = isKeepableReply(reply, state.status)
    ? withPreviousReply(cut, prompt, priorQuestions, reply)
    : cut;
  const record = next.previousReplies;
  return {
    ok: true,
    start,
    text: prompt.text,
    state: next,
    previousReplies: isRecordFor(record, prompt, priorQuestions) ? record.replies.length : 0,
  };
}

/** Why an earlier answer cannot be put back. */
export type RestorePreviousReplyRefusal =
  /** No earlier answer is kept for the chat's last question. */
  | "no_previous_reply"
  /** `index` is not one of the kept answers. */
  | "bad_index"
  /** The last question's current turn cannot be taken back (see {@link planLastTurnRollback}). */
  | Exclude<LastTurnRollbackRefusal, "nothing_to_undo" | "turn_mismatch">;

export type RestorePreviousReplyPlan =
  | {
      ok: true;
      /** The answer now in the transcript. */
      text: string;
      state: SessionState;
      /** Earlier answers the question has after the swap. */
      previousReplies: number;
    }
  | { ok: false; code: RestorePreviousReplyRefusal };

/**
 * The earlier answers kept for the chat's last question, oldest first,
 * and whether that question is in the transcript (`false` after a
 * regenerate whose new try never reached the store). Empty when the kept
 * answers are for a question the chat has moved past.
 */
export function listPreviousReplies(state: SessionState): {
  question: string | null;
  questionStored: boolean;
  replies: readonly PreviousReply[];
} {
  const record = state.previousReplies;
  if (record === undefined) return { question: null, questionStored: false, replies: [] };
  const total = countQuestions(state.turns);
  if (total === record.priorQuestions) {
    return { question: record.prompt.text, questionStored: false, replies: record.replies };
  }
  if (total === record.priorQuestions + 1) {
    const last = lastQuestionRow(state);
    if (last !== undefined && isRecordFor(record, last, record.priorQuestions)) {
      return { question: record.prompt.text, questionStored: true, replies: record.replies };
    }
  }
  return { question: null, questionStored: false, replies: [] };
}

/**
 * Put an earlier answer to the chat's last question back (ATO-864).
 *
 * Two cases. The question is in the transcript (the new try answered,
 * or failed with its record stored): its current turn is taken back
 * under every rule of {@link planLastTurnRollback} (no tools, no steer,
 * not stopped, not compacted), its answer, when a real one, joins the
 * kept ones, and the question goes back with the chosen answer, closed
 * as a turn the way the loop closes one. Or the question is not in the
 * transcript (the new try never reached the store): the kept question
 * row and the chosen answer are appended.
 *
 * `index` is into the kept answers, oldest first; default the newest.
 * The chosen answer leaves the kept list. Only the transcript changes,
 * so the model then reads the chosen answer as if it had been the only
 * one.
 */
export function planRestorePreviousReply(
  state: SessionState,
  index?: number,
): RestorePreviousReplyPlan {
  if (LIVE_SESSION_STATUSES.includes(state.status)) {
    return { ok: false, code: "turn_in_progress" };
  }
  const listed = listPreviousReplies(state);
  const record = state.previousReplies;
  if (listed.replies.length === 0 || record === undefined) {
    return { ok: false, code: "no_previous_reply" };
  }
  const at = index ?? listed.replies.length - 1;
  if (!Number.isInteger(at) || at < 0 || at >= listed.replies.length) {
    return { ok: false, code: "bad_index" };
  }
  const chosen = listed.replies[at]!;

  let base: SessionState;
  let prompt = record.prompt;
  if (listed.questionStored) {
    const rollback = planLastTurnRollback(state, {
      expectText: record.prompt.text,
      expectPriorQuestions: record.priorQuestions,
    });
    if (!rollback.ok) {
      // Both were checked above, so neither can be the reason now.
      if (rollback.code === "nothing_to_undo" || rollback.code === "turn_mismatch") {
        return { ok: false, code: "no_previous_reply" };
      }
      return { ok: false, code: rollback.code };
    }
    base = rollback.state;
    const row = state.turns[rollback.start];
    if (row?.kind === "user") prompt = row;
  } else {
    base = state;
  }

  const kept = (base.previousReplies?.replies ?? []).filter((entry) => entry !== chosen);
  let next: SessionState = { ...base, turns: [...base.turns, prompt, chosen.reply] };
  if (kept.length > 0) {
    next.previousReplies = { prompt, priorQuestions: record.priorQuestions, replies: kept };
  } else {
    delete next.previousReplies;
  }
  next = incrementTurnCount(next);
  next = { ...next, status: "pending", lastError: null, updatedAt: Date.now() };
  return { ok: true, text: chosen.reply.text, state: next, previousReplies: kept.length };
}

function lastQuestionRow(state: SessionState) {
  for (let i = state.turns.length - 1; i >= 0; i -= 1) {
    const row = state.turns[i];
    if (row?.kind === "user" && row.steered !== true) return row;
  }
  return undefined;
}
