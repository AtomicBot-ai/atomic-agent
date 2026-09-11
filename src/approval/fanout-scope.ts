import { isAbsolute, relative, resolve } from "node:path";

/**
 * Which directories a session's tool calls may write in without asking.
 *
 * Fusion's workers are the reason this exists. A worker turn has no
 * operator at the other end — the TUI is showing the parent session — so
 * `worker-runner.ts` installs a refuse policy and every approval-gated
 * call dies on it. At approval level 1 that is every write, and a real
 * session proved the consequence: six workers, zero files, and an
 * orchestrator left as the only party able to act.
 *
 * The answer the operator chose is one question per fan-out rather than
 * one per call: `fusion.delegate` asks once, naming the tasks and the
 * directory they will write in, and every worker in that fan-out then
 * writes inside it unprompted.
 *
 * **Why this is not an `ApprovalGate` grant.** The gate's grants are
 * keyed by category, and `recordGrant` takes the granted value from the
 * pending request, so there is nowhere to put a path. Categories are
 * also the wrong unit: a fan-out writing to `/tmp/rel-2` is outside the
 * workspace, and the category wide enough to cover it (`other`) would
 * authorise writing anywhere at all. A directory is the honest scope, so
 * a directory is what is stored.
 *
 * Scopes are per session id, in memory, and cleared when the fan-out
 * ends — the same lifetime and the same `finally` as the refuse policy
 * they sit beside.
 */
export class FanoutScopeRegistry {
  private readonly dirsBySession = new Map<string, readonly string[]>();

  /**
   * Authorise `dirs` (absolute, already resolved) for `sessionId`.
   * Replaces any previous grant: a session runs one fan-out task.
   */
  grant(sessionId: string, dirs: readonly string[]): void {
    const absolute = dirs.filter((dir) => isAbsolute(dir));
    if (absolute.length === 0) {
      this.dirsBySession.delete(sessionId);
      return;
    }
    this.dirsBySession.set(sessionId, absolute);
  }

  /** Drop a session's scope. Safe to call when nothing was granted. */
  clear(sessionId: string): void {
    this.dirsBySession.delete(sessionId);
  }

  /**
   * Whether every one of `paths` sits inside a granted directory.
   *
   * All or nothing on purpose: a call that writes three files, one of
   * them outside the scope, is not a call the operator authorised. It
   * goes to the gate, where the refuse policy turns it into a task the
   * orchestrator must re-delegate.
   */
  allows(sessionId: string, paths: readonly string[]): boolean {
    const dirs = this.dirsBySession.get(sessionId);
    if (dirs === undefined || paths.length === 0) return false;
    return paths.every((path) =>
      dirs.some((dir) => isInside(dir, resolve(path))),
    );
  }

  /** The granted directories, for a prompt or a diagnostic. */
  scopeFor(sessionId: string): readonly string[] {
    return this.dirsBySession.get(sessionId) ?? [];
  }
}

/**
 * Boundary-safe containment: `child` equals `parent` or lives under it.
 *
 * `relative()` rather than `startsWith`, so `/tmp/rel-2-backup` is not
 * read as living inside `/tmp/rel-2`.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}
