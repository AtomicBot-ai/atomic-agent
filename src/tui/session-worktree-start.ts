/**
 * `/new worktree` for the TUI (ATO-576): mint a session, move it into a
 * git worktree of its own, and sweep idle worktrees whose branches are
 * merged. The git work lives in `session/session-worktree.ts`; this file
 * only wires it to the runtime's session store.
 */
import { join } from "node:path";
import type { SessionState } from "../session/session-state.js";
import { LIVE_SESSION_STATUSES } from "../session/session-retention.js";
import { bindSessionWorktree, SessionWorktreeError, unbindSessionWorktree } from "../session/session-worktree.js";
import { cleanupIdleSessionWorktrees, type WorktreeCleanupResult } from "../session/session-worktree-cleanup.js";

export interface WorktreeSessionRuntime {
  readonly config: { readonly paths: { readonly stateDir: string } };
  createSession(input?: { metadata?: Record<string, unknown>; persist?: boolean }): SessionState;
  readonly sessionStore: {
    load(id: string): SessionState | null;
    save(state: SessionState): void;
  };
}

export function sessionWorktreesDir(stateDir: string): string {
  return join(stateDir, "worktrees");
}

export type WorktreeSessionStart =
  | { ok: true; session: SessionState; notice: string }
  | { ok: false; message: string };

/**
 * A new session bound to a fresh worktree, saved right away so the
 * cleanup can find it later. On failure nothing is created or saved and
 * `message` says why in plain words (not a git repo, no commit yet, …).
 */
export async function startWorktreeSession(runtime: WorktreeSessionRuntime): Promise<WorktreeSessionStart> {
  const draft = runtime.createSession({ persist: false });
  let session: SessionState;
  try {
    session = await bindSessionWorktree(draft, { worktreesDir: sessionWorktreesDir(runtime.config.paths.stateDir) });
  } catch (err) {
    const message = err instanceof SessionWorktreeError ? err.message : `could not create a worktree: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, message };
  }
  runtime.sessionStore.save(session);
  const wt = session.worktree!;
  return {
    ok: true,
    session,
    notice: `new session in its own worktree: branch ${wt.branch} at ${wt.path} (from ${wt.baseBranch ?? wt.baseCommit.slice(0, 12)})`,
  };
}

/**
 * Remove idle worktrees whose branches are merged and that hold no
 * uncommitted change. A removed worktree's session, when it still
 * exists, is pointed back at the folder it started from.
 */
export async function sweepIdleWorktrees(
  runtime: WorktreeSessionRuntime,
  activeSessionIds: ReadonlySet<string>,
): Promise<WorktreeCleanupResult> {
  return cleanupIdleSessionWorktrees({
    worktreesDir: sessionWorktreesDir(runtime.config.paths.stateDir),
    activeSessionIds,
    lastActiveAt: (id) => {
      const state = runtime.sessionStore.load(id);
      if (state === null) return null;
      // A turn still running in another window counts as activity now.
      return LIVE_SESSION_STATUSES.includes(state.status) ? Date.now() : state.updatedAt;
    },
    onRemoved: (marker) => {
      const state = runtime.sessionStore.load(marker.sessionId);
      if (state?.worktree?.path === marker.path) runtime.sessionStore.save(unbindSessionWorktree(state));
    },
  });
}
