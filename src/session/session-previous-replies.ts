import type { ConversationTurn } from "./conversation-turn.js";
import type { SessionState, SessionStatus } from "./session-state.js";

/**
 * Earlier answers to the chat's last question (ATO-864).
 *
 * "Regenerate" takes the last plain question and answer back and asks
 * the question again (`planLastTurnRollback`). Without this, the old
 * answer was simply gone: if the new try failed (no network, no
 * credits) or came out worse, there was nothing to go back to. ChatGPT
 * and Claude keep every try of a turn and let the person flip between
 * them ("< 1/2 >"), with only the one on screen in the model's context.
 * This is the same idea, kept to the last question only.
 *
 * The answers live beside the transcript, never in `turns`, so the
 * prompt builder, the packer, compaction and memory never read them:
 * the model only ever sees the answer currently in the transcript. One
 * record per chat, for one question, identified by its text and its
 * position (how many questions come before it, steers not counted), the
 * same pair the rollback route checks.
 */

export type AssistantReplyRow = Extract<ConversationTurn, { kind: "assistant_reply" }>;
export type UserRow = Extract<ConversationTurn, { kind: "user" }>;

export interface PreviousReply {
  /** The transcript row, kept as it was, so a restore puts it back exactly. */
  reply: AssistantReplyRow;
  /** When it was taken out of the transcript. */
  replacedAt: number;
}

export interface PreviousReplies {
  /**
   * The question row the answers were for, as stored, so a restore can
   * put the question back too when the new try never reached the store.
   */
  prompt: UserRow;
  /** Questions before it (user rows that opened a turn, steers not counted). */
  priorQuestions: number;
  /** Oldest first; at most {@link PREVIOUS_REPLIES_CAP}. */
  replies: PreviousReply[];
}

/** How many earlier answers one question keeps; the oldest go first. */
export const PREVIOUS_REPLIES_CAP = 10;

/** Questions in `turns` (user rows that opened a turn, steers not counted). */
export function countQuestions(turns: readonly ConversationTurn[]): number {
  return turns.filter((turn) => turn.kind === "user" && turn.steered !== true).length;
}

/**
 * Whether `row`, the answer a turn ended on with `status`, is an answer
 * worth keeping: something the model said, not a stop marker, a progress
 * note, a failed turn's record (the loop stores one as a reply and marks
 * the session `failed`), or a reply that came with tool work.
 */
export function isKeepableReply(
  row: ConversationTurn | undefined,
  status: SessionStatus,
): row is AssistantReplyRow {
  if (row?.kind !== "assistant_reply") return false;
  if (status === "failed" || status === "stalled") return false;
  if (row.progressNote === true || row.stopped === true || row.toolsRan === true) {
    return false;
  }
  if ((row.attachments?.length ?? 0) > 0) return false;
  return row.text.trim().length > 0;
}

/** Whether `record` is for the question `prompt` at position `priorQuestions`. */
export function isRecordFor(
  record: PreviousReplies | undefined,
  prompt: { text: string },
  priorQuestions: number,
): record is PreviousReplies {
  return (
    record !== undefined &&
    record.priorQuestions === priorQuestions &&
    record.prompt.text.trim() === prompt.text.trim()
  );
}

/**
 * `state` with `reply` kept as an earlier answer to `prompt`. A record
 * for another question is replaced: only the last question keeps
 * answers.
 */
export function withPreviousReply(
  state: SessionState,
  prompt: UserRow,
  priorQuestions: number,
  reply: AssistantReplyRow,
  now = Date.now(),
): SessionState {
  const current = state.previousReplies;
  const kept = isRecordFor(current, prompt, priorQuestions) ? current.replies : [];
  const replies = [...kept, { reply, replacedAt: now }];
  return {
    ...state,
    previousReplies: {
      prompt,
      priorQuestions,
      replies:
        replies.length > PREVIOUS_REPLIES_CAP
          ? replies.slice(replies.length - PREVIOUS_REPLIES_CAP)
          : replies,
    },
  };
}

/**
 * A stored record, or `undefined` when it is malformed (a hand-edited or
 * truncated payload). Used on load; a bad record is dropped, never fixed.
 */
export function readPreviousReplies(value: unknown): PreviousReplies | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<PreviousReplies>;
  const prompt = record.prompt as Partial<UserRow> | undefined;
  if (
    prompt?.kind !== "user" ||
    typeof prompt.text !== "string" ||
    typeof record.priorQuestions !== "number" ||
    !Number.isInteger(record.priorQuestions) ||
    record.priorQuestions < 0 ||
    !Array.isArray(record.replies)
  ) {
    return undefined;
  }
  const replies = record.replies.filter(
    (entry): entry is PreviousReply =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as PreviousReply).reply?.kind === "assistant_reply" &&
      typeof (entry as PreviousReply).reply.text === "string" &&
      typeof (entry as PreviousReply).replacedAt === "number",
  );
  if (replies.length === 0) return undefined;
  return {
    prompt: prompt as UserRow,
    priorQuestions: record.priorQuestions,
    replies: replies.slice(-PREVIOUS_REPLIES_CAP),
  };
}
