import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  formatUninstallPlan,
  isEmptyPlan,
  stripPathBlock,
  type UninstallPlan,
} from "./uninstall-plan.js";

export interface UninstallOutcome {
  readonly removed: readonly string[];
  readonly edited: readonly string[];
  readonly failures: readonly { path: string; reason: string }[];
}

export interface RunUninstallDeps {
  readonly rm: (path: string) => void;
  readonly readFile: (path: string) => string | null;
  readonly writeFile: (path: string, contents: string) => void;
}

export const defaultUninstallDeps: RunUninstallDeps = {
  rm: (path) => rmSync(path, { recursive: true, force: true }),
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeFile: (path, contents) => writeFileSync(path, contents, "utf8"),
};

/**
 * Execute a plan. Every removal is attempted even when an earlier one
 * fails: a half-uninstalled tree is worse than a reported error, and the
 * operator can act on a complete failure list. The binary is removed
 * last so that a failure partway through still leaves a runnable command
 * to retry with.
 */
export function runUninstall(
  plan: UninstallPlan,
  deps: RunUninstallDeps = defaultUninstallDeps,
): UninstallOutcome {
  const removed: string[] = [];
  const edited: string[] = [];
  const failures: { path: string; reason: string }[] = [];

  for (const edit of plan.pathEdits) {
    try {
      const contents = deps.readFile(edit.file);
      if (contents === null) continue;
      const next = stripPathBlock(contents, edit.marker);
      if (next !== contents) {
        deps.writeFile(edit.file, next);
        edited.push(edit.file);
      }
    } catch (error) {
      failures.push({
        path: edit.file,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ordered = [...plan.targets].sort((a, b) => {
    // Directories and state first; the binary itself last.
    const rank = (label: string) => (label === "binary" ? 1 : 0);
    return rank(a.label) - rank(b.label);
  });

  for (const target of ordered) {
    try {
      deps.rm(target.path);
      removed.push(target.path);
    } catch (error) {
      failures.push({
        path: target.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { removed, edited, failures };
}

/** Render the result of an executed plan. */
export function formatUninstallOutcome(outcome: UninstallOutcome): string {
  const lines: string[] = [];
  for (const path of outcome.removed) lines.push(`removed ${path}`);
  for (const file of outcome.edited) lines.push(`updated ${file}`);
  for (const failure of outcome.failures) {
    lines.push(`failed  ${failure.path}: ${failure.reason}`);
  }
  if (lines.length === 0) lines.push("nothing to remove");
  return lines.join("\n");
}

export { formatUninstallPlan, isEmptyPlan, existsSync };
