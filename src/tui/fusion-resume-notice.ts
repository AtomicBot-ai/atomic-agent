import type { ResumableFusionRun } from "../runtime/runtime-contract.js";

/**
 * The one-line offers for fusion runs a restart cut off (ATO-617).
 *
 * Shown, never acted on: a resume may run workers again, and those cost
 * time and money, so it is always the person's `/fusion resume`.
 */

/** On opening a session: its own unfinished run, if any. */
export function formatSessionFusionNotice(
  runs: readonly ResumableFusionRun[],
): string | null {
  const newest = runs[0];
  if (newest === undefined) return null;
  const more =
    runs.length > 1 ? ` (${runs.length - 1} older one${runs.length === 2 ? "" : "s"} too: /fusion lists them)` : "";
  return `${capitalise(newest.summary)}${more}. /fusion resume continues from the unfinished wave · /fusion discard drops it`;
}

/**
 * At start-up, before any session is opened: where unfinished runs are.
 * The runs of `currentSessionId` are left to the session notice.
 */
export function formatStartupFusionNotice(
  runs: readonly ResumableFusionRun[],
  currentSessionId: string | null,
): string | null {
  const elsewhere = runs.filter((run) => run.sessionId !== currentSessionId);
  if (elsewhere.length === 0) return null;
  const sessions = [...new Set(elsewhere.map((run) => run.sessionId))];
  const where =
    sessions.length === 1
      ? `session ${sessions[0]}`
      : `${sessions.length} sessions (${sessions.slice(0, 3).join(", ")}${sessions.length > 3 ? ", …" : ""})`;
  return `${elsewhere.length} Fusion run${elsewhere.length === 1 ? " was" : "s were"} cut off before finishing, in ${where}. Open it from /sessions and type /fusion resume to continue, or /fusion discard to drop it.`;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}
