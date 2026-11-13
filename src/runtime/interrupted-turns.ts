import {
  interruptedChatTurn,
  interruptedTurnResumeMessage,
  type InterruptedChatTurn,
} from "../session/interrupted-chat-turn.js";
import type { SessionStore } from "../session/session-store.js";

/**
 * The runtime's side of continuing a chat turn a restart cut off
 * (ATO-448), shared by every frontend: the TUI's `/resume`, and the
 * desktop or an HTTP client when they offer the same.
 *
 * Never continues a turn on its own. `pending` says whether there is
 * one; `resumeMessage` hands back the message of the turn that
 * continues it and marks it "resume queued", so a second call says
 * there is nothing to resume. The caller sends that message as the
 * person's turn through `runTurn`, like any other.
 *
 * The progress marker itself is not dropped here: the continuing turn
 * replaces it when it really starts (`SessionStore.beginTurn`). Until
 * then the "queued" mark lives only in memory, so a message that never
 * runs (the person cleared the queue, stopped the run, switched away)
 * is given back with `release`, and a process that quits first leaves
 * the turn offered at the next start.
 */
export interface InterruptedTurns {
  pending(sessionId: string): InterruptedChatTurn | null;
  resumeMessage(sessionId: string): string | null;
  /** The continuing message was dropped before its turn started: offer the turn again. */
  release(sessionId: string): void;
}

export function createInterruptedTurns(
  store: Pick<SessionStore, "load" | "readTurnProgress">,
): InterruptedTurns {
  /** Session id -> `startedAt` of the cut-off turn a resume is queued for. */
  const queued = new Map<string, number>();
  const read = (sessionId: string): InterruptedChatTurn | null => {
    const state = store.load(sessionId);
    if (state === null) return null;
    return interruptedChatTurn(state, store.readTurnProgress(sessionId));
  };
  const pending = (sessionId: string): InterruptedChatTurn | null => {
    const turn = read(sessionId);
    const queuedFor = queued.get(sessionId);
    if (queuedFor === undefined) return turn;
    // Still the same cut-off turn: its resume is queued, not yet started.
    if (turn !== null && turn.startedAt === queuedFor) return null;
    // The continuing turn started (it replaced the marker) or the row
    // changed under us: the queued mark has done its job.
    queued.delete(sessionId);
    return turn;
  };
  return {
    pending,
    resumeMessage(sessionId) {
      const turn = pending(sessionId);
      if (turn === null) return null;
      queued.set(sessionId, turn.startedAt);
      return interruptedTurnResumeMessage(turn);
    },
    release(sessionId) {
      queued.delete(sessionId);
    },
  };
}
