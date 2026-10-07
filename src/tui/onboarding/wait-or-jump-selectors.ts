import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";

/**
 * What the pull is actually doing, which is the one thing this screen
 * is allowed to claim. The pull can end — cleanly or not — while the
 * second cloud wizard hides this screen, and the flow still returns
 * here; a screen that assumed "running" would then draw a 0% bar for a
 * download that is over. Failure is read from the panel's `errorLine`
 * because the reducer nulls the pull itself when it fails.
 */
export type WaitOrJumpPullStatus = "running" | "ready" | "failed";

export function waitOrJumpPullStatus(
  pull: LocalModelsPullState | null,
  errorLine: string | null,
): WaitOrJumpPullStatus {
  if (pull !== null) return "running";
  return errorLine !== null ? "failed" : "ready";
}

/** A failed pull adds the retry row; the keyboard has to agree. */
export function waitOrJumpRowCount(status: WaitOrJumpPullStatus): number {
  return status === "failed" ? 3 : 2;
}
