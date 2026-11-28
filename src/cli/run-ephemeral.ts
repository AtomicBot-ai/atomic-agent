import { removeIncognitoTrace } from "../runtime/incognito-sessions.js";
import type { SessionStore } from "../session/session-store.js";

/**
 * `run --ephemeral` (ATO-2440, Codex `exec --ephemeral`): the chat is not
 * kept. Unlike `--incognito` the run is an ordinary chat while it lasts,
 * so memory still learns from it; only the chat itself (its row, archived
 * turns and trace file) is deleted when the run ends.
 *
 * Called right before `runtime.shutdown()` with no await in between, the
 * way `run --incognito` discards its chat: a late session-title save
 * checks for teardown first, so it cannot write the row back.
 */
export function discardEphemeralChat(
  sessionStore: Pick<SessionStore, "delete">,
  tracesDir: string | null | undefined,
  sessionId: string,
): boolean {
  try {
    // The runtime's wrapped delete: recorder, shell jobs, spill folder.
    sessionStore.delete(sessionId);
  } catch {
    return false;
  }
  removeIncognitoTrace(tracesDir, sessionId);
  return true;
}
