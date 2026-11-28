import type { ConversationTurn } from "./conversation-turn.js";
import {
  deriveTurnEnds,
  foldStaleReplies,
  keepBranch,
  questionIndexAt,
  repliesAsBranches,
  withBranches,
  type MessageBranch,
} from "./session-message-branches.js";
import { appendMacroTurnStart } from "./macro-turn-starts.js";
import { countQuestions } from "./session-previous-replies.js";
import { LIVE_SESSION_STATUSES } from "./session-retention.js";
import type { SessionState } from "./session-state.js";
import {
  listPreviousReplies,
  planRestorePreviousReply,
  truncateSessionAt,
  type RestorePreviousReplyRefusal,
} from "./session-truncate.js";

/**
 * Every version of every question in a chat (ATO-2470), for the
 * "< 2/3 >" switchers: the branches an edit kept
 * (`session-message-branches.ts`) and the answers Regenerate kept for the
 * last question (`session-previous-replies.ts`), and switching to one.
 *
 * A version is named by `ref`: `b<i>` is the i-th branch of the chat,
 * `r<i>` the i-th kept answer. Both count from the state as it is read,
 * so a listing and the switch that follows it agree as long as nothing
 * changed between them; the question is also named by its position and
 * text, and a different one refuses.
 */

export interface MessageVersion {
  ref: string;
  /** The question the version starts with. */
  text: string;
  /** When that question was sent. */
  at: number;
  /** When its answer was written, or null when it has none. */
  answerAt: number | null;
  /** When it was taken out of the chat. */
  keptAt: number;
}

export interface QuestionVersions {
  /** Questions before it, steers not counted. */
  priorQuestions: number;
  /** The version in the chat now; null when the question is not in the transcript. */
  live: { text: string; at: number; answerAt: number | null } | null;
  /** The other versions, in no particular order (a client orders them by `at` / `answerAt`). */
  versions: MessageVersion[];
  /** The question is inside a compacted part: a switch there refuses. */
  compacted: boolean;
}

/** The answer a question's turn ended on, from `start` (its row) to the next question. */
function answerAt(turns: readonly ConversationTurn[], start: number): number | null {
  let found: number | null = null;
  for (let i = start + 1; i < turns.length; i += 1) {
    const row = turns[i]!;
    if (row.kind === "user" && row.steered !== true) break;
    if (row.kind === "assistant_reply" && row.progressNote !== true && row.text.trim().length > 0) found = row.at;
  }
  return found;
}

/** The questions of `state` that have another version, oldest question first. */
export function listMessageVersions(original: SessionState): QuestionVersions[] {
  const state = foldStaleReplies(original);
  const byPosition = new Map<number, MessageVersion[]>();
  const add = (position: number, version: MessageVersion): void => {
    byPosition.set(position, [...(byPosition.get(position) ?? []), version]);
  };
  const total = countQuestions(state.turns);
  (state.messageBranches ?? []).forEach((branch, index) => {
    if (branch.priorQuestions > total) return;
    const first = branch.turns[0]!;
    add(branch.priorQuestions, {
      ref: `b${index}`,
      text: first.kind === "user" ? first.text : "",
      at: first.at,
      answerAt: answerAt(branch.turns, 0),
      keptAt: branch.keptAt,
    });
  });
  const record = state.previousReplies;
  const replies = listPreviousReplies(state).replies;
  if (record !== undefined) {
    replies.forEach((entry, index) => {
      add(record.priorQuestions, {
        ref: `r${index}`,
        text: record.prompt.text,
        at: record.prompt.at,
        answerAt: entry.reply.at,
        keptAt: entry.replacedAt,
      });
    });
  }
  const covered = state.compaction?.coveredThrough ?? 0;
  return [...byPosition.keys()].sort((a, b) => a - b).map((position) => {
    const at = questionIndexAt(state.turns, position);
    const row = at < 0 ? undefined : state.turns[at];
    return {
      priorQuestions: position,
      live: row?.kind === "user" ? { text: row.text, at: row.at, answerAt: answerAt(state.turns, at) } : null,
      versions: byPosition.get(position) ?? [],
      compacted: at >= 0 && at < covered,
    };
  });
}

/** Why a switch was refused. */
export type SwitchVersionRefusal =
  /** `ref` is not a version of that question (or was never one). */
  | "no_version"
  /** The question at that position is not the one given. */
  | "point_mismatch"
  /** The question is inside the part a compaction checkpoint summarises. */
  | "point_compacted"
  | Exclude<RestorePreviousReplyRefusal, "no_previous_reply" | "bad_index">;

export type SwitchVersionPlan =
  | {
      ok: true;
      /** The question now in the chat. */
      text: string;
      state: SessionState;
      /** Other versions that question has now. */
      versions: number;
    }
  | { ok: false; code: SwitchVersionRefusal };

export interface SwitchVersionRequest {
  priorQuestions: number;
  /** The question the caller shows at that position; a different stored one refuses. */
  expectText?: string;
  ref: string;
}

function versionsAt(state: SessionState, position: number): number {
  return listMessageVersions(state).find((q) => q.priorQuestions === position)?.versions.length ?? 0;
}

/**
 * Put version `ref` of the question at `priorQuestions` in the chat. The
 * conversation from that question on is kept as a branch first (the way
 * an edit keeps it), so switching back is one more call. Only the rows from
 * that question on change: the ones before it, and the prompt prefix built
 * from them, stay byte for byte.
 */
export function planSwitchVersion(original: SessionState, request: SwitchVersionRequest): SwitchVersionPlan {
  if (LIVE_SESSION_STATUSES.includes(original.status)) return { ok: false, code: "turn_in_progress" };
  const state = foldStaleReplies(original);
  const position = request.priorQuestions;
  const liveAt = questionIndexAt(state.turns, position);
  const live = liveAt < 0 ? undefined : state.turns[liveAt];
  if (
    live?.kind === "user" &&
    request.expectText !== undefined &&
    live.text.trim() !== request.expectText.trim()
  ) {
    return { ok: false, code: "point_mismatch" };
  }
  if (live === undefined && countQuestions(state.turns) !== position) return { ok: false, code: "no_version" };
  const match = /^([br])(\d+)$/.exec(request.ref);
  if (match === null) return { ok: false, code: "no_version" };
  const index = Number(match[2]);

  if (match[1] === "r") {
    const record = state.previousReplies;
    if (record === undefined || record.priorQuestions !== position) return { ok: false, code: "no_version" };
    const plan = planRestorePreviousReply(state, index);
    if (!plan.ok) return { ok: false, code: plan.code === "bad_index" || plan.code === "no_previous_reply" ? "no_version" : plan.code };
    return { ok: true, text: record.prompt.text, state: plan.state, versions: versionsAt(plan.state, position) };
  }

  const chosen = state.messageBranches?.[index];
  if (chosen === undefined || chosen.priorQuestions !== position) return { ok: false, code: "no_version" };
  let base: SessionState;
  if (liveAt >= 0) {
    const { state: cut, compactionCovered } = truncateSessionAt(state, liveAt);
    if (compactionCovered) return { ok: false, code: "point_compacted" };
    base = keepBranch(state, liveAt, cut);
  } else {
    // The question is not in the transcript (a regenerate whose new try
    // never reached the store): its kept answers stay versions of it.
    base = { ...state };
    const record = base.previousReplies;
    if (record !== undefined && record.priorQuestions === position) {
      base = withBranches(base, [...(base.messageBranches ?? []), ...repliesAsBranches(record)]);
      delete base.previousReplies;
    }
  }
  const first = chosen.turns[0];
  const text = first?.kind === "user" ? first.text : "";
  return { ok: true, text, ...restoreBranch(base, chosen, position) };
}

/** `base` (cut at the question) with `chosen` appended as the live conversation. */
function restoreBranch(
  base: SessionState,
  chosen: MessageBranch,
  position: number,
): { state: SessionState; versions: number } {
  const start = base.turns.length;
  const ends = chosen.turnEnds.length > 0 ? chosen.turnEnds : deriveTurnEnds(chosen.turns);
  let starts = base.macroTurnStarts;
  if (starts !== undefined) {
    for (const end of ends) starts = appendMacroTurnStart(starts, start + end);
  }
  const others = (base.messageBranches ?? []).filter((branch) => branch !== chosen);
  let next: SessionState = withBranches(
    { ...base, turns: [...base.turns, ...chosen.turns] },
    [...others, ...(chosen.branches ?? [])],
  );
  next = {
    ...next,
    turnCount: base.turnCount + ends.length,
    status: "pending",
    lastError: null,
    updatedAt: Date.now(),
  };
  if (starts !== undefined) next.macroTurnStarts = starts;
  if (chosen.previousReplies !== undefined) next.previousReplies = chosen.previousReplies;
  else delete next.previousReplies;
  return { state: next, versions: versionsAt(next, position) };
}
