import type { ConversationTurn } from "./conversation-turn.js";
import type { SessionState } from "./session-state.js";
import {
  countQuestions,
  readPreviousReplies,
  type PreviousReplies,
  type UserRow,
} from "./session-previous-replies.js";

/**
 * Earlier versions of a sent message (ATO-2470).
 *
 * Editing a sent message takes the chat back to just before it and sends
 * the new text (a rewind, `route-session-rewind.ts`). Without this the old
 * message, its answer and everything after them were simply gone. ChatGPT
 * and Claude.ai keep every edit as a branch and let the person flip between
 * them ("< 2/2 >") on the message; this keeps the cut-off tail the same way.
 *
 * A branch is the rows from one question to the end of the chat, as they
 * were when they were cut off, at a position (how many questions come
 * before it, steers not counted). The branches of later questions that
 * belonged to that tail travel inside it (`branches`), and so do the
 * answers Regenerate kept for its last question (`previousReplies`): put
 * back, the whole conversation comes back as it was.
 *
 * Like `previousReplies` they live beside the transcript, never in
 * `turns`: the prompt builder, the packer, compaction and memory never
 * read them, so the model only ever sees the conversation on screen, and
 * the rows before the cut (the stable prefix) are not touched.
 *
 * The answers Regenerate kept for a question are folded into branches of
 * one question and one answer once the chat has moved past that question
 * ({@link foldStaleReplies}), so they stay versions of an earlier answer
 * instead of being dropped by the next regenerate.
 */

export interface MessageBranch {
  /** Questions before the cut (user rows that opened a turn, steers not counted). */
  priorQuestions: number;
  /** The cut-off rows, oldest first; the first is the question. */
  turns: ConversationTurn[];
  /** Where each closed turn of `turns` ended, relative to `turns[0]` (the `macroTurnStarts` shape). */
  turnEnds: number[];
  /** When it was cut off. */
  keptAt: number;
  /** The answers Regenerate kept for the tail's last question, when it had some. */
  previousReplies?: PreviousReplies;
  /** Branches of later questions that belonged to the tail. */
  branches?: MessageBranch[];
}

/** Branches kept for one position; the oldest go first. */
export const MESSAGE_BRANCHES_PER_QUESTION = 10;
/** Branches kept for a whole chat, nested ones counted; the oldest go first. */
export const MESSAGE_BRANCHES_TOTAL = 30;
/** Serialized size of every kept branch together (characters of JSON); the oldest go first. */
export const MESSAGE_BRANCHES_MAX_CHARS = 2_000_000;
/** Nesting deeper than this is dropped on load (a hand-edited payload). */
const MAX_DEPTH = 8;

/** Where each closed turn of `rows` ends, read from its questions (for state without `macroTurnStarts`). */
export function deriveTurnEnds(rows: readonly ConversationTurn[]): number[] {
  const ends: number[] = [];
  rows.forEach((row, index) => {
    if (index > 0 && row.kind === "user" && row.steered !== true) ends.push(index);
  });
  if (rows.length > 0) ends.push(rows.length);
  return ends;
}

/** Index of the question with `priorQuestions` questions before it, or -1. */
export function questionIndexAt(turns: readonly ConversationTurn[], priorQuestions: number): number {
  let seen = 0;
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]!;
    if (turn.kind !== "user" || turn.steered === true) continue;
    if (seen === priorQuestions) return i;
    seen += 1;
  }
  return -1;
}

function branchWeight(branch: MessageBranch): number {
  return 1 + (branch.branches ?? []).reduce((n, b) => n + branchWeight(b), 0);
}

/**
 * `list` within the bounds: at most {@link MESSAGE_BRANCHES_PER_QUESTION}
 * per position, {@link MESSAGE_BRANCHES_TOTAL} in all and
 * {@link MESSAGE_BRANCHES_MAX_CHARS} of JSON. The oldest (by `keptAt`) go
 * first, whatever position they are at. Order is kept.
 */
export function capBranches(list: readonly MessageBranch[]): MessageBranch[] {
  let kept = [...list];
  const dropOldest = (pick: (b: MessageBranch) => boolean): void => {
    let oldest = -1;
    kept.forEach((b, i) => {
      if (pick(b) && (oldest < 0 || b.keptAt < kept[oldest]!.keptAt)) oldest = i;
    });
    if (oldest >= 0) kept.splice(oldest, 1);
  };
  for (const position of new Set(kept.map((b) => b.priorQuestions))) {
    while (kept.filter((b) => b.priorQuestions === position).length > MESSAGE_BRANCHES_PER_QUESTION) {
      dropOldest((b) => b.priorQuestions === position);
    }
  }
  while (kept.length > 0 && kept.reduce((n, b) => n + branchWeight(b), 0) > MESSAGE_BRANCHES_TOTAL) {
    dropOldest(() => true);
  }
  while (kept.length > 0 && JSON.stringify(kept).length > MESSAGE_BRANCHES_MAX_CHARS) {
    dropOldest(() => true);
  }
  return kept;
}

/** `state` with `list` as its branches (none: the field goes). */
export function withBranches(state: SessionState, list: readonly MessageBranch[]): SessionState {
  const next: SessionState = { ...state };
  const capped = capBranches(list);
  if (capped.length > 0) next.messageBranches = capped;
  else delete next.messageBranches;
  return next;
}

/** One branch per kept answer: the question and that answer, one closed turn. */
export function repliesAsBranches(record: PreviousReplies): MessageBranch[] {
  return record.replies.map((entry) => ({
    priorQuestions: record.priorQuestions,
    turns: [record.prompt, entry.reply],
    turnEnds: [2],
    keptAt: entry.replacedAt,
  }));
}

/**
 * `state` with the answers Regenerate kept turned into branches, once the
 * chat has moved past their question (a later question was sent) and that
 * question is still in the transcript as it was. Any other state is
 * returned as is. Deterministic, so a listing and the switch that follows
 * it number the branches the same way.
 */
export function foldStaleReplies(state: SessionState): SessionState {
  const record = state.previousReplies;
  if (record === undefined) return state;
  if (countQuestions(state.turns) <= record.priorQuestions + 1) return state;
  const at = questionIndexAt(state.turns, record.priorQuestions);
  const row = at < 0 ? undefined : state.turns[at];
  if (row?.kind !== "user" || row.text.trim() !== record.prompt.text.trim()) return state;
  const next = withBranches(state, [...(state.messageBranches ?? []), ...repliesAsBranches(record)]);
  delete next.previousReplies;
  return next;
}

/**
 * `after` (the session already cut at `cut`, a question row of `before`)
 * with the rows that were cut kept as a branch. The branches of later
 * questions and the kept answers of the tail go inside it. A cut that is
 * not at a question returns `after` as is.
 */
export function keepBranch(
  before: SessionState,
  cut: number,
  after: SessionState,
  now = Date.now(),
): SessionState {
  const source = foldStaleReplies(before);
  const row = source.turns[cut];
  if (row?.kind !== "user" || row.steered === true) return after;
  const priorQuestions = countQuestions(source.turns.slice(0, cut));
  const turns = source.turns.slice(cut);
  const turnEnds =
    source.macroTurnStarts !== undefined
      ? source.macroTurnStarts.filter((value) => value > cut).map((value) => value - cut)
      : deriveTurnEnds(turns);
  const record = source.previousReplies;
  const nested = (source.messageBranches ?? []).filter((b) => b.priorQuestions > priorQuestions);
  const branch: MessageBranch = {
    priorQuestions,
    turns,
    turnEnds,
    keptAt: now,
    ...(record !== undefined && record.priorQuestions >= priorQuestions ? { previousReplies: record } : {}),
    ...(nested.length > 0 ? { branches: nested } : {}),
  };
  const live = (after.messageBranches ?? []).filter((b) => b.priorQuestions <= priorQuestions);
  const next = withBranches(after, [...live, branch]);
  if (next.previousReplies !== undefined && next.previousReplies.priorQuestions >= priorQuestions) {
    delete next.previousReplies;
  }
  return next;
}

/**
 * Stored branches, or `undefined` when none is readable. Used on load: a
 * malformed entry (hand-edited or truncated payload) is dropped, never fixed.
 */
export function readMessageBranches(value: unknown, depth = 0): MessageBranch[] | undefined {
  if (!Array.isArray(value) || depth > MAX_DEPTH) return undefined;
  const list: MessageBranch[] = [];
  for (const entry of value) {
    const branch = readBranch(entry, depth);
    if (branch !== undefined) list.push(branch);
  }
  return list.length > 0 ? list : undefined;
}

function readBranch(value: unknown, depth: number): MessageBranch | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Partial<MessageBranch>;
  const first = Array.isArray(raw.turns) ? (raw.turns[0] as Partial<UserRow> | undefined) : undefined;
  if (
    typeof raw.priorQuestions !== "number" ||
    !Number.isInteger(raw.priorQuestions) ||
    raw.priorQuestions < 0 ||
    typeof raw.keptAt !== "number" ||
    !Array.isArray(raw.turns) ||
    first?.kind !== "user" ||
    typeof first.text !== "string"
  ) {
    return undefined;
  }
  const turns = raw.turns as ConversationTurn[];
  const ends = Array.isArray(raw.turnEnds)
    ? raw.turnEnds.filter((n): n is number => Number.isInteger(n) && n > 0 && n <= turns.length)
    : [];
  const branch: MessageBranch = {
    priorQuestions: raw.priorQuestions,
    turns,
    turnEnds: ends.length > 0 ? ends : deriveTurnEnds(turns),
    keptAt: raw.keptAt,
  };
  const record = raw.previousReplies === undefined ? undefined : readPreviousReplies(raw.previousReplies);
  if (record !== undefined) branch.previousReplies = record;
  const nested = raw.branches === undefined ? undefined : readMessageBranches(raw.branches, depth + 1);
  if (nested !== undefined) branch.branches = nested;
  return branch;
}
