import { isAbsolute, resolve } from "node:path";

import { isInside } from "./fanout-scope.js";

/**
 * Directories a session may READ in without being asked again.
 *
 * A read outside the working directory and the paths the user named
 * asks through the ladder as `fs_read_outside` (`src/tools/read-scope/`).
 * The operator's plain `y` is not a one-shot: it names a directory —
 * the one the model reached for, or the parent of the file it reached
 * for — and every later read under that directory in the same session
 * runs unasked. One question per place, not one per file: a model
 * summarising a folder of reports would otherwise ask once per report,
 * and answering the same question fifty times is attrition, not
 * consent.
 *
 * **Why this is not an `ApprovalGate` category grant.** A category
 * grant (`[s]`) is "read anywhere this session" — the honest scope for
 * an operator who would otherwise set `agent.readScope: unrestricted`,
 * and it is offered too. This registry is the narrower answer, and it
 * has to be keyed by a path, which the gate's grants have nowhere to
 * hold (the same reason `fanout-scope.ts` gives). It lives on the gate
 * beside them so it shares their lifetime: `clearSessionGrants` drops
 * both when the operator leaves the session.
 *
 * The roots here join the session's working directory and user-named
 * paths (`ToolContext.readRoots`) when the read scope is checked; they
 * are never written back into the transcript, so a saved session starts
 * its next run with only what the user named.
 */
export class ReadScopeGrants {
  private readonly rootsBySession = new Map<string, string[]>();

  /**
   * Remember that `sessionId` may read under `dir`. A directory already
   * covered by an earlier root is a no-op; a root the new one covers is
   * folded into it, so the list stays a set of disjoint roots.
   */
  widen(sessionId: string, dir: string): void {
    if (!isAbsolute(dir)) return;
    const root = resolve(dir);
    const roots = this.rootsBySession.get(sessionId) ?? [];
    if (roots.some((known) => isInside(known, root))) return;
    this.rootsBySession.set(sessionId, [
      ...roots.filter((known) => !isInside(root, known)),
      root,
    ]);
  }

  /** The directories `sessionId` was granted, in the order they were. */
  rootsFor(sessionId: string): readonly string[] {
    return this.rootsBySession.get(sessionId) ?? [];
  }

  /**
   * Drop a session's roots — or every session's, with no argument — the
   * same two forms `ApprovalGate.clearSessionGrants` takes.
   */
  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.rootsBySession.clear();
      return;
    }
    this.rootsBySession.delete(sessionId);
  }
}
