/**
 * ATO-1696 (ATO-1688): what a quit asks before it goes, as one question.
 *
 * ATO-135 asked only when messages were still queued in a chat. A turn that
 * was running (in the chat on screen or in one left in the background) was
 * stopped by the quit without a word: the person came back to a chat whose
 * reply had been cut off. A quit now asks about both, in one dialog, and
 * asks nothing when there is neither.
 */

export interface QuitWork {
  /** Messages queued in the chats, waiting for their chat's turn to end (ATO-135). */
  queued: number;
  /** Chats whose turn is running now (main's liveTurns, counted by chat). */
  working: number;
}

export interface QuitQuestion {
  message: string;
  detail: string;
}

/** The dialog's text, or null when the quit should go without asking. */
export function quitQuestion(work: QuitWork): QuitQuestion | null {
  const queued = count(work.queued);
  const working = count(work.working);
  if (queued === 0 && working === 0) return null;
  if (working === 0) {
    return {
      message: queued === 1 ? "A queued message has not been sent" : `${queued} queued messages have not been sent`,
      detail: "They wait for their chat's turn to end. Quitting now drops them.",
    };
  }
  const message = working === 1 ? "A chat is still working" : `${working} chats are still working`;
  const stops = working === 1 ? "Quitting now stops its reply before it is done." : "Quitting now stops their replies before they are done.";
  const drops = queued === 0 ? ""
    : queued === 1 ? " A queued message is dropped too." : ` ${queued} queued messages are dropped too.`;
  return { message, detail: `${stops}${drops}` };
}

/** The chats with a turn running: one per chat, a new chat's first turn on its own (it has no id yet). */
export function workingChatCount(turns: Iterable<{ turnId: string; sessionId: string | null }>): number {
  const chats = new Set<string>();
  for (const t of turns) chats.add(t.sessionId ? `s:${t.sessionId}` : `t:${t.turnId}`);
  return chats.size;
}

function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
