/**
 * Parallel tabs for fusion workers (ATO-961).
 *
 * Each worker browses in tabs of its own, named by its session id: it
 * never sees, switches to or closes another worker's tabs, and the
 * orchestrator's chat does not see the workers' tabs either. When the
 * worker's turn ends its tabs close.
 *
 * `browser.workerIsolation`:
 * - `"tabs"` (default): the worker's tabs are in the agent's profile, so
 *   it keeps the logins the agent has, as before.
 * - `"context"`: each worker gets its own throwaway browser context (no
 *   cookies, storage or logins shared with the agent or other workers).
 *
 * `browser.maxTabs` caps the tabs the agent has open at once, workers and
 * throwaway profiles included; opening one more fails with
 * {@link BrowserTabLimitError} until a tab closes.
 */

export type BrowserWorkerIsolation = "tabs" | "context";

export const BROWSER_WORKER_ISOLATIONS: readonly BrowserWorkerIsolation[] = ["tabs", "context"];

export const DEFAULT_BROWSER_MAX_TABS = 8;
export const MIN_BROWSER_MAX_TABS = 1;
export const MAX_BROWSER_MAX_TABS = 50;

export class BrowserTabLimitError extends Error {
  constructor(
    readonly open: number,
    readonly max: number,
  ) {
    super(
      `browser: ${open} tabs are already open, the limit is ${max} (browser.maxTabs). ` +
        "Close one with browser.tabs { action: \"close\", index } and try again.",
    );
    this.name = "BrowserTabLimitError";
  }
}
