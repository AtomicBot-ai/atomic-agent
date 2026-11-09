/**
 * Which sessions have a host that can draw `os.screen.point` marks on
 * this computer's screen (ATO-1018): today only the desktop app, on the
 * chat stream it opens to its own local agent with
 * `X-Atomic-Screen-Overlay: 1`.
 *
 * Off by default, so the TUI, channels, tasks and a remote desktop get
 * the plain "marks need the desktop app" answer instead of marks that
 * nobody draws. Same lifecycle as `turn-progress-opt-in.ts`: the HTTP
 * stream claims it for its session while the stream is open.
 *
 * Counted, not a set: two streams on one session (a retry racing the
 * old one) each hold their own claim.
 */
const claims = new Map<string, number>();

/** Mark `sessionId` as drawn by an overlay host until the returned release is called. */
export function claimScreenOverlay(sessionId: string): () => void {
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

export function screenOverlayAvailable(sessionId: string): boolean {
  return (claims.get(sessionId) ?? 0) > 0;
}
