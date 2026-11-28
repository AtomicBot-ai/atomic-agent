/**
 * ATO-2754: a word on screen while a quit asks the agent what is still running.
 *
 * Since ATO-1758 the first Quit asks the agent (running tasks, busy turns)
 * before it asks the person anything (quit-question.ts). Both answers come in
 * milliseconds, but a stalled agent holds the quit for up to QUIT_PROBE_MS
 * (1.5 s) with nothing on screen, and people pressed Quit again. Slack and
 * Claude's desktop app quit at once and show nothing; that only works when
 * the wait is short, so here the wait stays bounded and, once it has lasted
 * longer than a glance (QUIT_NOTICE_MS, the usual "show progress after about
 * 0.4 s" rule), the window says "Checking running chats…" until the answer
 * is in. A quick answer shows nothing at all, as before.
 */

/** How long the quit waits for the agent before the window says what it is doing. */
export const QUIT_NOTICE_MS = 400;

/**
 * `say(true)` once `probe` has run longer than `ms`, then `say(false)` when it
 * settles; nothing at all when it settles first. Never throws, never holds the probe.
 */
export function noticeWhileChecking(probe: Promise<unknown>, say: (on: boolean) => void, ms: number = QUIT_NOTICE_MS): void {
  let shown = false;
  let settled = false;
  const tell = (on: boolean) => { try { say(on); } catch { /* the window went: nothing to tell */ } };
  const timer = setTimeout(() => { if (!settled) { shown = true; tell(true); } }, ms);
  const done = () => { settled = true; clearTimeout(timer); if (shown) tell(false); };
  probe.then(done, done);
}
