import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { applyPatch } from "diff";
import type { StructuredPatch } from "diff";

/**
 * Per-file outcome of applying a patch. Tracked per target so the tool can
 * report "files 1/3 applied, 2/3 rejected" instead of silently dropping
 * bad hunks.
 */
export interface FileOutcome {
  path: string;
  absolute: string;
  applied: boolean;
  reason?: string;
  addedLines: number;
  removedLines: number;
}

export interface PreviewOutcome extends FileOutcome {
  /** Raw source content at the time of preview (used again when we decide to write). */
  originalContent?: string;
  /** Whether the target was on disk at preview time — a patch may create a file. */
  existed: boolean;
}

/** Try one file of the patch against the disk without writing anything. */
export async function dryRunFile(
  hunkFile: StructuredPatch,
  rootDir: string,
  fuzzFactor: number,
  stripComponents: number,
): Promise<PreviewOutcome> {
  const targetRel = pickTargetPath(hunkFile, stripComponents);
  const abs = isAbsolute(targetRel) ? targetRel : resolve(rootDir, targetRel);
  const counts = countPatchLines(hunkFile);

  let originalContent = "";
  let existed = false;
  try {
    const info = await stat(abs);
    if (!info.isFile()) {
      return {
        path: targetRel,
        absolute: abs,
        applied: false,
        reason: "target is not a regular file",
        addedLines: counts.added,
        removedLines: counts.removed,
        existed: true,
      };
    }
    originalContent = await readFile(abs, "utf8");
    existed = true;
  } catch (err) {
    const isMissing = (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isMissing) {
      return {
        path: targetRel,
        absolute: abs,
        applied: false,
        reason: `cannot read target: ${(err as Error).message}`,
        addedLines: counts.added,
        removedLines: counts.removed,
        existed: false,
      };
    }
    // Missing target is fine only if the patch creates the file from
    // scratch (empty original). Let applyPatch decide.
  }

  const patched = applyPatch(originalContent, hunkFile, { fuzzFactor });
  if (patched === false) {
    return {
      path: targetRel,
      absolute: abs,
      applied: false,
      reason: `hunk(s) did not match (fuzzFactor=${fuzzFactor})`,
      addedLines: counts.added,
      removedLines: counts.removed,
      originalContent,
      existed,
    };
  }
  return {
    path: targetRel,
    absolute: abs,
    applied: true,
    addedLines: counts.added,
    removedLines: counts.removed,
    originalContent,
    existed,
  };
}

function pickTargetPath(
  hunkFile: StructuredPatch,
  stripComponents: number,
): string {
  // Prefer the "new" side; fall back to the "old" side for pure deletions.
  const raw =
    typeof hunkFile.newFileName === "string" &&
    hunkFile.newFileName !== "/dev/null"
      ? hunkFile.newFileName
      : (hunkFile.oldFileName ?? "");
  return stripPathComponents(raw, stripComponents);
}

function stripPathComponents(p: string, n: number): string {
  if (n <= 0) return p;
  // Drop `a/`, `b/` prefixes that `git diff` emits.
  const parts = p.split(/[\\/]/);
  return parts.slice(Math.min(n, parts.length - 1)).join("/");
}

function countPatchLines(hunkFile: StructuredPatch): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const hunk of hunkFile.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}
