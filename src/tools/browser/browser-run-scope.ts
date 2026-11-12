import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who is driving the browser right now (ATO-959).
 *
 * The browser backend is one per process and its methods take no
 * session, so the turn that calls a browser tool is carried here, set
 * by the runtime around each turn (`runtime-turn-service.ts`). Every
 * `await` inside the turn, tool calls included, sees the same value.
 *
 * - `sessionId`: the turn's session (a fusion worker's own session).
 * - `attended`: a person is watching this turn's chat (the TUI, the
 *   desktop app, a `run` in a terminal). A scheduled task, a Telegram or
 *   Discord message, a webhook or a plain HTTP client is not.
 * - `workerOf`: set for a fusion worker's turn, the session that fanned
 *   it out. A worker browses only in its own tabs (ATO-961).
 */
export interface BrowserRunScope {
  sessionId: string;
  attended: boolean;
  workerOf?: string;
}

const scopes = new AsyncLocalStorage<BrowserRunScope>();

export function runInBrowserScope<T>(scope: BrowserRunScope, fn: () => T): T {
  return scopes.run(scope, fn);
}

/** The calling turn's scope; `undefined` outside a turn (tests, a direct call). */
export function currentBrowserScope(): BrowserRunScope | undefined {
  return scopes.getStore();
}

type WorkerEndListener = (workerSessionId: string) => void;
const workerEndListeners = new Set<WorkerEndListener>();

/**
 * Called when a fusion worker's turn ends (its whole life): the browser
 * closes the worker's tabs. Returns the unsubscribe.
 */
export function onBrowserWorkerEnd(listener: WorkerEndListener): () => void {
  workerEndListeners.add(listener);
  return () => {
    workerEndListeners.delete(listener);
  };
}

/** The runtime's half of {@link onBrowserWorkerEnd}. Never throws. */
export function endBrowserWorker(workerSessionId: string): void {
  for (const listener of workerEndListeners) {
    try {
      listener(workerSessionId);
    } catch {
      // A browser that fails to tidy up must not fail the worker's turn.
    }
  }
}

/**
 * Origins where nobody watches the chat while the turn runs. A plain
 * string so this module does not import from `src/runtime`.
 */
const UNATTENDED_ORIGINS: ReadonlySet<string> = new Set([
  "scheduler",
  "telegram",
  "discord",
  "http",
]);

/**
 * Whether a turn has a person watching it. `interactive` (the TUI chat,
 * the desktop's HTTP extensions client) always is; otherwise the origin
 * decides, and an unknown or missing origin (`cli`, `tui`, `sidecar`)
 * counts as watched, which keeps the window as before.
 */
export function isAttendedTurn(origin: string | undefined, interactive: boolean | undefined): boolean {
  if (interactive === true) return true;
  return origin === undefined || !UNATTENDED_ORIGINS.has(origin);
}

/**
 * `browser.headless` after env and file: `true` / `false` were set by the
 * user and always win; `"auto"` lets the turn decide.
 */
export type BrowserHeadlessSetting = boolean | "auto";

/**
 * Should a Chrome launched now be headless? `auto`: only for a turn no
 * one watches (a cron task, a bridge). Outside any turn the window stays,
 * as before the setting existed.
 */
export function resolveLaunchHeadless(
  setting: BrowserHeadlessSetting,
  scope: BrowserRunScope | undefined,
): boolean {
  if (setting !== "auto") return setting;
  return scope !== undefined && !scope.attended;
}
