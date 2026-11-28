/**
 * The state half of `github.pr.autofix` that is not the push (ATO-2516):
 * how a state reads back to the model, the `watch` turn-on, and the
 * write rule that keeps the background watcher's bookkeeping.
 */

import {
  startWatch,
  type AutofixState,
  type AutofixStore,
  type AutofixWatch,
} from "../../github/index.js";

export function describeWatch(watch: AutofixWatch | undefined): string {
  if (!watch) return "not watched";
  const minutes = Math.round(watch.everyMs / 60_000);
  const report = watch.notify ? `reports here and by ${watch.notify}` : "reports here";
  return `watched every ${minutes} min, ${report}`;
}

export function describeState(state: AutofixState | undefined, dir: string): string {
  if (!state) return "off (never enabled)";
  if (!state.enabled) return "off";
  return `${state.paused ? "paused" : "on"}, ${state.attempts} of ${state.maxAttempts} attempts used, branch ${state.headRef}, worktree ${dir}, ${describeWatch(state.watch)}`;
}

/**
 * Write the tool's view of a PR's state, keeping the `watch` the file
 * holds NOW: the watcher may have moved its bookkeeping since the tool
 * read the state, and the tool never owns that field except through
 * `watch`, `unwatch` and `disable` (which pass `watch` explicitly).
 */
export function saveKeepingWatch(
  store: AutofixStore,
  key: string,
  next: AutofixState,
): Promise<AutofixState | undefined> {
  return store.update(key, (current) => {
    const { watch: _stale, ...rest } = next;
    void _stale;
    return current?.watch ? { ...rest, watch: current.watch } : rest;
  });
}

/** Turn the watch on (or re-point it) for an enabled PR; the counter is untouched. */
export function saveWatch(
  store: AutofixStore,
  key: string,
  input: { sessionId: string; notify: unknown; everyMinutes: unknown },
  now: Date,
): Promise<AutofixState | undefined> {
  return store.update(key, (current) =>
    current ? { ...current, watch: startWatch(input, now), updatedAt: now.toISOString() } : undefined,
  );
}

/** Stop watching; with `disable`, autofix goes off too. */
export function saveUnwatch(
  store: AutofixStore,
  key: string,
  now: Date,
  disable: boolean,
): Promise<AutofixState | undefined> {
  return store.update(key, (current) => {
    if (!current) return undefined;
    const { watch: _old, ...rest } = current;
    void _old;
    return { ...rest, ...(disable ? { enabled: false } : {}), updatedAt: now.toISOString() };
  });
}
