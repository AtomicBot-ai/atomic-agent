/**
 * Wall-clock and scanned-entry budget for an in-process directory walk.
 *
 * `os.fs.glob` used to bound only how many *matches* it collected, so a
 * walk rooted at a home directory with a narrow pattern visited every
 * entry on disk: one call ran for 7.8 minutes. The budget stops the walk
 * after `maxMs` or `maxEntries` visited entries, whichever comes first,
 * and the tool returns what it found so far with a note telling the
 * model to narrow the pattern or the root. Cancellation is not a budget
 * stop: an aborted signal throws, the same as other fs tools.
 */

export interface WalkBudgetLimits {
  /** Wall-clock milliseconds from the start of the walk. */
  maxMs: number;
  /** Directory entries visited (files, directories, anything else). */
  maxEntries: number;
}

export interface WalkBudgetDeps {
  /** Injected clock; tests drive it instead of waiting. */
  now?: () => number;
  signal?: AbortSignal;
}

export type WalkStopReason = "time" | "entries";

export interface WalkStop {
  reason: WalkStopReason;
  elapsedMs: number;
  scanned: number;
}

export interface WalkBudget {
  /**
   * Called before each visited entry and before each `readdir`. Throws
   * on an aborted signal; otherwise returns the stop once a limit is
   * reached (and keeps returning it), or `null` to carry on.
   */
  check(scanned: number): WalkStop | null;
}

/**
 * Generous for a project tree (a large monorepo minus the default ignore
 * list is well under both), small enough that a home-directory walk
 * hands control back to the model in seconds rather than minutes. The
 * time limit matches `os.fs.grep`'s default ripgrep timeout. The glob
 * contract quotes both numbers to the model (contracts stay import-free),
 * and a test keeps the two in step.
 */
export const DEFAULT_WALK_BUDGET: WalkBudgetLimits = {
  maxMs: 30_000,
  maxEntries: 200_000,
};

export function createWalkBudget(
  limits: WalkBudgetLimits,
  deps: WalkBudgetDeps = {},
): WalkBudget {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let stop: WalkStop | null = null;
  return {
    check(scanned) {
      deps.signal?.throwIfAborted();
      if (stop !== null) return stop;
      const elapsedMs = now() - startedAt;
      if (scanned >= limits.maxEntries) {
        stop = { reason: "entries", elapsedMs, scanned };
      } else if (elapsedMs >= limits.maxMs) {
        stop = { reason: "time", elapsedMs, scanned };
      }
      return stop;
    },
  };
}

/** The line the model reads when a walk stopped early. */
export function describeWalkStop(stop: WalkStop): string {
  const seconds = Math.round(stop.elapsedMs / 100) / 10;
  const limit =
    stop.reason === "time" ? "time limit reached" : "entry limit reached";
  return (
    `[partial results: walk stopped after ${seconds} s / ${stop.scanned} entries scanned (${limit}); ` +
    "files not yet visited are missing. Narrow the pattern or the root (cwd) and retry.]"
  );
}
