import { isAbsolute } from "node:path";

/**
 * Which files a session may edit in place but never replace — the
 * fan-out contract's `inputs` (F51), keyed by worker session.
 *
 * The same shape as `FanoutScopeRegistry`, for the same reason: a tool
 * sees only its `ToolContext`, so a fact about the session it runs in
 * has to be looked up by session id. The worker runner declares a
 * worker's inputs before its turn and clears them in the same `finally`
 * as its refuse policy; `os.fs.write` asks `inputsOf` before it
 * replaces anything (`fs-input-guard.ts`). An orchestrator or a plain
 * session never has an entry here, so the registry says nothing about
 * them — their inputs are the request's, checked by name.
 */
export class DeclaredInputsRegistry {
  private readonly bySession = new Map<string, readonly string[]>();

  /** Declare `paths` (absolute, already resolved) for `sessionId`; replaces any earlier list. */
  declare(sessionId: string, paths: readonly string[]): void {
    const absolute = [...new Set(paths.filter((path) => isAbsolute(path)))];
    if (absolute.length === 0) {
      this.bySession.delete(sessionId);
      return;
    }
    this.bySession.set(sessionId, absolute);
  }

  /** Drop a session's list. Safe to call when nothing was declared. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** The absolute paths declared for `sessionId`; empty when none. */
  inputsOf(sessionId: string): readonly string[] {
    return this.bySession.get(sessionId) ?? [];
  }
}
