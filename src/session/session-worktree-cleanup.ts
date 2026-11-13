/**
 * Cleanup of idle session worktrees (ATO-576).
 *
 * A session worktree is removed only when all of these hold:
 *  - its session is not one the caller marks as active;
 *  - nothing happened in the session for `idleMs` (the session's
 *    `updatedAt`, or the worktree's creation time when the session row
 *    is gone);
 *  - its branch is fully merged into the branch it started from
 *    (`git merge-base --is-ancestor`), so no commit is lost;
 *  - the removal preflight passes: no uncommitted or untracked change,
 *    and no ignored file other than regenerable ones such as node_modules.
 *
 * Anything else is kept and reported with the reason. A squash-merged
 * branch does not count as merged here; it stays until the person
 * removes it. Never throws on one bad worktree; each is judged alone.
 */
import {
  defaultSessionGitExec,
  isWorktreeBranchMerged,
  listSessionWorktreeMarkers,
  removeSessionWorktree,
  type SessionGitExec,
  type SessionWorktreeMarker,
} from "./session-worktree.js";

/** One day: a worktree someone stepped away from for an afternoon is not idle. */
export const DEFAULT_WORKTREE_IDLE_MS = 24 * 60 * 60 * 1000;

export interface WorktreeCleanupOptions {
  worktreesDir: string;
  /** Sessions never touched, e.g. the one on screen or one running a turn. */
  activeSessionIds?: ReadonlySet<string>;
  /** Last activity of a session, `null` when the session no longer exists. */
  lastActiveAt: (sessionId: string) => number | null;
  idleMs?: number;
  now?: () => number;
  exec?: SessionGitExec;
  /** Called after a worktree is removed, so the caller can point its session back at the original folder. */
  onRemoved?: (marker: SessionWorktreeMarker) => void;
}

export interface WorktreeCleanupResult {
  removed: SessionWorktreeMarker[];
  kept: { marker: SessionWorktreeMarker; reason: string }[];
}

export async function cleanupIdleSessionWorktrees(options: WorktreeCleanupOptions): Promise<WorktreeCleanupResult> {
  const exec = options.exec ?? defaultSessionGitExec;
  const now = (options.now ?? Date.now)();
  const idleMs = options.idleMs ?? DEFAULT_WORKTREE_IDLE_MS;
  const result: WorktreeCleanupResult = { removed: [], kept: [] };
  for (const marker of await listSessionWorktreeMarkers(options.worktreesDir)) {
    const reason = await judge(marker);
    if (reason === null) {
      result.removed.push(marker);
      try {
        options.onRemoved?.(marker);
      } catch {
        // The worktree is already gone; a failed follow-up must not stop the sweep.
      }
    } else {
      result.kept.push({ marker, reason });
    }
  }
  return result;

  async function judge(marker: SessionWorktreeMarker): Promise<string | null> {
    if (options.activeSessionIds?.has(marker.sessionId)) return "the session is active";
    const last = options.lastActiveAt(marker.sessionId) ?? marker.createdAt;
    if (now - last < idleMs) return "the session was used recently";
    try {
      if (!(await isWorktreeBranchMerged(marker, exec))) return "the branch has commits that are not merged";
      return await removeSessionWorktree(marker, exec);
    } catch (err) {
      return `cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
