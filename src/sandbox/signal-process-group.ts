import type { ChildProcess } from "node:child_process";

import { killProcessTree } from "./kill-process-tree.js";

const IS_WINDOWS = process.platform === "win32";

/**
 * Signal the child's whole process group. On POSIX the child leads its
 * own group (spawned `detached`), so `-pid` reaches everything the
 * command started — a subshell's `sleep 30 &` included. Without that a
 * background grandchild survives the kill and, still holding the stdio
 * pipes, keeps the job from closing until it exits on its own. A group
 * that is already gone falls back to the direct kill, a no-op then. On
 * Windows the tree-kill (`taskkill /T`) walks the descendants instead.
 */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (IS_WINDOWS) {
    killProcessTree(child, { force: signal === "SIGKILL" });
    return;
  }
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // group gone — fall through to the direct child
    }
  }
  try {
    child.kill(signal);
  } catch {
    // process already exited
  }
}
