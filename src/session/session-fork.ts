import { randomUUID } from "node:crypto";

import type { SessionState } from "./session-state.js";
import { LIVE_SESSION_STATUSES } from "./session-retention.js";
import { truncateSessionAt } from "./session-truncate.js";
import {
  readSessionTitle,
  SESSION_TITLE_MAX_CHARS,
  SESSION_TITLE_METADATA_KEY,
  SESSION_TITLE_USER_SET_AT_KEY,
} from "./session-title.js";

/**
 * Forking a chat from one of its messages (ATO-1058): a new chat with a
 * copy of the history up to that point, so the person can take the
 * conversation another way without losing the original.
 *
 * The point is a question, picked the way a client sees it: by how many
 * questions come before it (steers not counted) and its text, the same
 * pair `POST /api/sessions/{id}/rollback-last-turn` takes. The fork keeps
 * that question and everything up to the next question, its answer and
 * tool steps included. To branch BEFORE a question, fork the answer
 * above it.
 */

/** Metadata on a forked chat: where it came from. */
export const FORKED_FROM_METADATA_KEY = "forkedFrom";

/**
 * Reserved keys of the source that describe how IT was started (a
 * schedule, a webhook, a Telegram chat), not its conversation: a fork is
 * a chat the person started, so they stay behind.
 */
const SOURCE_ONLY_METADATA_KEYS = [
  "wakeReason",
  "recurringTask",
  "scheduleKind",
  "webhookName",
  "webhookPersistent",
  "ephemeralTask",
  "scheduledBy",
  SESSION_TITLE_USER_SET_AT_KEY,
];

/** The row index of the question with `priorQuestions` questions before it, or -1. */
export function questionRowIndex(state: SessionState, priorQuestions: number): number {
  let seen = 0;
  for (let i = 0; i < state.turns.length; i++) {
    const turn = state.turns[i]!;
    if (turn.kind !== "user" || turn.steered === true) continue;
    if (seen === priorQuestions) return i;
    seen += 1;
  }
  return -1;
}

/** Where that question's turn ends: the next question's row, or the end. */
export function questionTurnEnd(state: SessionState, turnIndex: number): number {
  for (let i = turnIndex + 1; i < state.turns.length; i++) {
    const turn = state.turns[i]!;
    if (turn.kind === "user" && turn.steered !== true) return i;
  }
  return state.turns.length;
}

export type ForkRefusal = "turn_in_progress" | "point_mismatch" | "point_compacted";

export type ForkPlan =
  | { ok: true; state: SessionState; title: string }
  | { ok: false; code: ForkRefusal };

export interface ForkOptions {
  priorQuestions: number;
  /** The question's text as the client shows it; compared trimmed. */
  expectText?: string;
  now?: number;
  newId?: () => string;
}

export function planFork(source: SessionState, options: ForkOptions): ForkPlan {
  if (LIVE_SESSION_STATUSES.includes(source.status)) {
    return { ok: false, code: "turn_in_progress" };
  }
  const start = questionRowIndex(source, options.priorQuestions);
  const row = start < 0 ? undefined : source.turns[start];
  if (row === undefined || row.kind !== "user") return { ok: false, code: "point_mismatch" };
  if (options.expectText !== undefined && options.expectText.trim() !== row.text.trim()) {
    return { ok: false, code: "point_mismatch" };
  }
  const cut = truncateSessionAt(source, questionTurnEnd(source, start));
  if (cut.compactionCovered) return { ok: false, code: "point_compacted" };

  const now = options.now ?? Date.now();
  const title = forkTitle(source);
  const metadata: Record<string, unknown> = { ...source.metadata };
  for (const key of SOURCE_ONLY_METADATA_KEYS) delete metadata[key];
  metadata[SESSION_TITLE_METADATA_KEY] = title;
  metadata[FORKED_FROM_METADATA_KEY] = { sessionId: source.id, turnIndex: start, at: now };

  const state: SessionState = {
    ...cut.state,
    id: options.newId ? options.newId() : `s-${randomUUID()}`,
    status: "completed",
    lastError: null,
    createdAt: now,
    updatedAt: now,
    metadata,
  };
  // What the source spent is the source's; the fork starts its own count.
  delete state.sessionUsage;
  delete state.contextUsage;
  delete state.compactionWarning;
  return { ok: true, state, title };
}

/** "<source title> (fork)", the source's name cut so the whole fits a title. */
export function forkTitle(source: SessionState): string {
  const suffix = " (fork)";
  const firstQuestion = source.turns.find((turn) => turn.kind === "user");
  const base =
    readSessionTitle(source.metadata) ??
    (firstQuestion?.kind === "user" ? firstQuestion.text.replace(/\s+/g, " ").trim() : "");
  const room = SESSION_TITLE_MAX_CHARS - suffix.length;
  const name = base.length > room ? `${base.slice(0, Math.max(1, room - 1)).trimEnd()}…` : base;
  return `${name.length > 0 ? name : "Chat"}${suffix}`;
}
