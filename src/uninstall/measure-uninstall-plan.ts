import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { UninstallTarget } from "./uninstall-targets.js";

export interface MeasuredTarget extends UninstallTarget {
  readonly exists: boolean;
  /** Bytes on disk, summed recursively. `0` when the target is missing. */
  readonly bytes: number;
}

export interface MeasuredPlan {
  /** Only the targets that exist — nothing else is worth showing. */
  readonly targets: readonly MeasuredTarget[];
  readonly totalBytes: number;
}

/**
 * Stat every target so the confirm screens can say *how much* is about
 * to go. Size is the argument the operator actually weighs — "1.7 GB of
 * models" stops a stray Enter in a way "~/.atomic-agent" does not.
 *
 * Never throws: a target we cannot stat is reported as missing rather
 * than failing the whole preview, because the preview's job is to be
 * shown, and an unreadable path is the removal step's problem.
 */
export async function measureUninstallPlan(
  targets: readonly UninstallTarget[],
): Promise<MeasuredPlan> {
  const measured: MeasuredTarget[] = [];
  for (const target of targets) {
    const bytes = await sizeOf(target.path);
    if (bytes === null) continue;
    measured.push({ ...target, exists: true, bytes });
  }
  return {
    targets: measured,
    totalBytes: measured.reduce((sum, t) => sum + t.bytes, 0),
  };
}

/** Recursive size in bytes, or `null` when the path is not there. */
async function sizeOf(path: string): Promise<number | null> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    // Readable enough to stat, not to list: report the directory as
    // present with an unknown interior rather than dropping it.
    return stat.size;
  }
  for (const entry of entries) {
    // Symlinks are counted at their own size, never followed — the
    // installer's `atag` points at a sibling, and following it would
    // double-count the binary.
    const child = await sizeOf(join(path, entry.name));
    total += child ?? 0;
  }
  return total;
}

/** `1.7 GB`, `124 KB`, `0 B` — one decimal, never scientific. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
