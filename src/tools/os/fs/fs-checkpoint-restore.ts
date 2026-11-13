import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  sha256Of,
  type CheckpointEntry,
  type CheckpointSkip,
  type FileCheckpointStore,
} from "./fs-checkpoint-store.js";

/**
 * What putting the files back to a point in a chat would do (ATO-1056),
 * and doing it. The point is a time: the files as they were before the
 * first change saved at or after it (`fs-checkpoint-store.ts`).
 *
 * The plan compares each saved copy with the disk now, so a change the
 * tool never made (an approval the person declined, a write that
 * failed) or a file already back as it was is left out: the confirmation
 * lists only files that will really change.
 */

export interface FileRestoreItem {
  path: string;
  /** `restore` writes the saved content back; `delete` removes a file the agent created. */
  action: "restore" | "delete";
  entry: CheckpointEntry;
}

export interface FileNotRestorable {
  path: string;
  reason: CheckpointSkip;
}

export interface FileRestorePlan {
  items: FileRestoreItem[];
  notRestorable: FileNotRestorable[];
  /** Some changes from that point on are no longer kept (the store's bounds). */
  incomplete: boolean;
}

export interface FileRestoreResult {
  restored: string[];
  deleted: string[];
  failed: { path: string; error: string }[];
}

type Store = Pick<FileCheckpointStore, "since" | "readCopy">;

export async function planFileRestore(
  store: Store,
  sessionId: string,
  sinceAt: number,
): Promise<FileRestorePlan> {
  const { entries, incomplete } = await store.since(sessionId, sinceAt);
  // The earliest copy of each path is what it held before the point.
  const first = new Map<string, CheckpointEntry>();
  for (const entry of entries) if (!first.has(entry.path)) first.set(entry.path, entry);
  const items: FileRestoreItem[] = [];
  const notRestorable: FileNotRestorable[] = [];
  for (const entry of first.values()) {
    const now = await currentState(entry.path);
    if (entry.skipped !== undefined) {
      notRestorable.push({ path: entry.path, reason: entry.skipped });
      continue;
    }
    if (!entry.existed) {
      if (now.kind === "missing") continue;
      if (now.kind === "other") notRestorable.push({ path: entry.path, reason: "not_a_file" });
      else items.push({ path: entry.path, action: "delete", entry });
      continue;
    }
    if (now.kind === "file" && now.sha256 === entry.sha256) continue;
    if (now.kind === "other") {
      notRestorable.push({ path: entry.path, reason: "not_a_file" });
      continue;
    }
    items.push({ path: entry.path, action: "restore", entry });
  }
  return { items, notRestorable, incomplete };
}

/** Carry out a plan. Each file is tried on its own; one failure does not stop the rest. */
export async function applyFileRestore(
  store: Store,
  sessionId: string,
  plan: FileRestorePlan,
): Promise<FileRestoreResult> {
  const result: FileRestoreResult = { restored: [], deleted: [], failed: [] };
  for (const item of plan.items) {
    try {
      if (item.action === "delete") {
        await rm(item.path, { force: true });
        result.deleted.push(item.path);
      } else {
        const content = await store.readCopy(sessionId, item.entry);
        await mkdir(dirname(item.path), { recursive: true });
        await writeFile(item.path, content);
        result.restored.push(item.path);
      }
    } catch (err) {
      result.failed.push({ path: item.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * Tools that change files without a checkpoint, among `rows` (the rows a
 * rollback removes): shell commands, archive extraction, git commands
 * that write the work tree or history, and Fusion workers (their own
 * sessions). The confirmation names them, since their changes stay.
 */
export function uncoveredToolCalls(
  rows: readonly { kind: string; tool?: string }[],
): { tool: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "assistant_tool_call" || typeof row.tool !== "string") continue;
    if (!changesFilesUnseen(row.tool)) continue;
    counts.set(row.tool, (counts.get(row.tool) ?? 0) + 1);
  }
  return [...counts].map(([tool, count]) => ({ tool, count }));
}

const READ_ONLY_GIT = new Set(["os.git.blame", "os.git.diff", "os.git.log", "os.git.show", "os.git.status"]);

function changesFilesUnseen(tool: string): boolean {
  if (tool.startsWith("os.shell.")) return true;
  if (tool === "os.fs.archive.extract") return true;
  if (tool === "fusion.delegate") return true;
  if (tool.startsWith("os.git.")) return !READ_ONLY_GIT.has(tool);
  return false;
}

type Current = { kind: "missing" } | { kind: "other" } | { kind: "file"; sha256: string };

async function currentState(path: string): Promise<Current> {
  try {
    // Followed like the capture follows it (`stat`).
    const info = await stat(path);
    if (!info.isFile()) return { kind: "other" };
    return { kind: "file", sha256: sha256Of(await readFile(path)) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "other" };
  }
}
