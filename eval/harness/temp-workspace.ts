import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempWorkspace {
  /** Root temp dir; both `workingDir` and `stateDir` live underneath. */
  root: string;
  workingDir: string;
  stateDir: string;
  /** Idempotent — safe to call from a finally block. */
  cleanup: () => void;
}

/**
 * Create an isolated workspace for a single eval case. Files written by
 * the agent (or by `setup`) land under `workingDir`; agent state (config,
 * traces, sessions.sqlite, skills) lands under `stateDir`. Both are
 * disposable — cleanup wipes the root.
 */
export function createTempWorkspace(caseId: string): TempWorkspace {
  const root = mkdtempSync(join(tmpdir(), `atomic-eval-${caseId}-`));
  const workingDir = join(root, "work");
  const stateDir = join(root, "state");
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  let disposed = false;
  return {
    root,
    workingDir,
    stateDir,
    cleanup: () => {
      if (disposed) return;
      disposed = true;
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort: leave the dir if the OS held a handle
      }
    },
  };
}
