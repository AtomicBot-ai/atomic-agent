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
 * continues it and records it as resumed (its progress marker is
 * dropped), so a second call says there is nothing to resume. The caller
 * sends that message as the person's turn through `runTurn`, like any
 * other.
 */
export interface InterruptedTurns {
  pending(sessionId: string): InterruptedChatTurn | null;
  resumeMessage(sessionId: string): string | null;
}

export function createInterruptedTurns(
  store: Pick<SessionStore, "load" | "readTurnProgress" | "clearTurnProgress">,
): InterruptedTurns {
  const pending = (sessionId: string): InterruptedChatTurn | null => {
    const state = store.load(sessionId);
    if (state === null) return null;
    return interruptedChatTurn(state, store.readTurnProgress(sessionId));
  };
  return {
    pending,
    resumeMessage(sessionId) {
      const turn = pending(sessionId);
      if (turn === null) return null;
      // Taken before the turn starts, not after: a second `/resume`
      // typed while the first is still queued must not send it twice.
      // The continuing turn writes its own marker when it begins.
      store.clearTurnProgress(sessionId);
      return interruptedTurnResumeMessage(turn);
    },
  };
}
