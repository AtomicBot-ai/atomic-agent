/**
 * Which sessions want the wait before the first token reported
 * (ATO-1027): `prompt_progress` (llama-server's `return_progress`) and
 * `first_token` step events.
 *
 * Off by default, so the TUI, channels, tasks and Fusion workers stream
 * exactly as before. The HTTP chat stream turns it on for its session
 * while an extensions stream (the desktop) is open, because that host
 * draws a status line from them; nothing else reads them.
 *
 * Counted, not a set: two streams on one session (a retry racing the
 * old one) each hold their own claim.
 */
const claims = new Map<string, number>();

/** Report the first-token wait for `sessionId` until the returned release is called. */
export function claimTurnProgress(sessionId: string): () => void {
  claims.set(sessionId, (claims.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (claims.get(sessionId) ?? 1) - 1;
    if (left <= 0) claims.delete(sessionId);
    else claims.set(sessionId, left);
  };
}

export function turnProgressWanted(sessionId: string): boolean {
  return (claims.get(sessionId) ?? 0) > 0;
}
