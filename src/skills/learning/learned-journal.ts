import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendSkillChange } from "../curator/skill-change-log.js";
import { isCuratableSkillName, type SkillCuratorPaths } from "../curator/skill-curator-config.js";
import { archiveSkill, restoreSkill } from "../curator/skill-history.js";

/**
 * The "Learned" list (ATO-67): one line per skill the experience review
 * wrote or patched, with a short id, and one line per undo. Append-only,
 * like the skill change log next to it; the folder copies themselves live
 * in the curator's history (`skills-history/<name>/<version>/`), which is
 * what an undo puts back. OpenClaw keeps the same list behind its
 * "Learned" rows and `/learn undo <id>`.
 */

export type LearnedAction = "create" | "patch";

export interface LearnedChange {
  /** Short id the operator types: `/learn undo <id>`. */
  id: string;
  /** Epoch ms. */
  at: number;
  /** Skill folder name. */
  name: string;
  action: LearnedAction;
  /** History version saved just before a patch; absent for a create. */
  snapshot?: string;
  /** The review's one-line reason, shown in the list. */
  reason: string;
  /** Session whose turn was reviewed. */
  sessionId?: string;
}

export interface LearnedEntry extends LearnedChange {
  /** Set once the change was undone. */
  undoneAt?: number;
}

type JournalLine =
  | ({ type: "learn" } & LearnedChange)
  | { type: "undo"; id: string; at: number };

export function learnedJournalFile(paths: Pick<SkillCuratorPaths, "historyDir">): string {
  return join(paths.historyDir, "learned.jsonl");
}

export function newLearnedId(): string {
  return randomBytes(3).toString("hex");
}

export async function appendLearnedChange(file: string, change: LearnedChange): Promise<void> {
  await appendLine(file, { type: "learn", ...change });
}

async function appendLine(file: string, line: JournalLine): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
}

function parseLine(raw: string): JournalLine | null {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj.id !== "string" || typeof obj.at !== "number") return null;
  if (obj.type === "undo") return { type: "undo", id: obj.id, at: obj.at };
  if (obj.type !== "learn") return null;
  if (typeof obj.name !== "string" || !isCuratableSkillName(obj.name)) return null;
  const action = obj.action;
  if (action !== "create" && action !== "patch") return null;
  return {
    type: "learn",
    id: obj.id,
    at: obj.at,
    name: obj.name,
    action,
    reason: typeof obj.reason === "string" ? obj.reason : "",
    ...(typeof obj.snapshot === "string" ? { snapshot: obj.snapshot } : {}),
    ...(typeof obj.sessionId === "string" ? { sessionId: obj.sessionId } : {}),
  };
}

/** Every learned change, oldest first, each marked when it was undone. */
export async function readLearnedChanges(file: string): Promise<LearnedEntry[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, LearnedEntry>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = parseLine(line);
    if (parsed === null) continue;
    if (parsed.type === "learn") {
      const change: LearnedEntry = {
        id: parsed.id, at: parsed.at, name: parsed.name, action: parsed.action, reason: parsed.reason,
        ...(parsed.snapshot !== undefined ? { snapshot: parsed.snapshot } : {}),
        ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
      };
      byId.set(change.id, change);
    } else {
      const entry = byId.get(parsed.id);
      if (entry && entry.undoneAt === undefined) entry.undoneAt = parsed.at;
    }
  }
  return [...byId.values()];
}

export interface UndoLearnedDirs {
  skillsDir: string;
  paths: SkillCuratorPaths;
}

export interface UndoLearnedResult {
  entry: LearnedEntry;
  /** `removed`: a created skill went to the archive; `restored`: a patch was rolled back. */
  outcome: "removed" | "restored" | "already-gone";
  /** History version of the copy that was live before the undo, so the undo can itself be undone. */
  savedAs: string | null;
}

export class LearnUndoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearnUndoError";
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Take one learned change back. A created skill moves to the archive
 * (`skill restore <name>` brings it back); a patch restores the version
 * saved before it, after saving the current copy. Only the newest live
 * change of a skill can be undone, so an undo never silently drops a
 * later change to the same skill.
 */
export async function undoLearnedChange(
  dirs: UndoLearnedDirs,
  id: string,
  now: number = Date.now(),
): Promise<UndoLearnedResult> {
  const file = learnedJournalFile(dirs.paths);
  const entries = await readLearnedChanges(file);
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new LearnUndoError(`no learned change with id ${id} (see /learn)`);
  if (entry.undoneAt !== undefined) throw new LearnUndoError(`learned change ${id} was already undone`);
  const blocking = entries
    .slice(entries.indexOf(entry) + 1)
    .find((e) => e.name === entry.name && e.undoneAt === undefined);
  if (blocking) {
    throw new LearnUndoError(`${entry.name} changed again after ${id}; undo ${blocking.id} first`);
  }

  const historyDirs = { skillsDir: dirs.skillsDir, historyDir: dirs.paths.historyDir, archiveDir: dirs.paths.archiveDir };
  let outcome: UndoLearnedResult["outcome"];
  let savedAs: string | null = null;
  if (entry.action === "create") {
    if (await isDir(join(dirs.skillsDir, entry.name))) {
      savedAs = await archiveSkill(historyDirs, entry.name, now);
      await appendSkillChange(dirs.paths.changeLog, {
        at: now, name: entry.name, action: "archive", actor: "user", tool: "learn-undo",
        ...(savedAs ? { snapshot: savedAs } : {}),
      });
      outcome = "removed";
    } else {
      outcome = "already-gone";
    }
  } else {
    if (!entry.snapshot) throw new LearnUndoError(`learned change ${id} has no saved version to go back to`);
    const result = await restoreSkill(historyDirs, entry.name, entry.snapshot, now).catch((err: unknown) => {
      throw new LearnUndoError(err instanceof Error ? err.message : String(err));
    });
    savedAs = result.snapshot;
    await appendSkillChange(dirs.paths.changeLog, {
      at: now, name: entry.name, action: "restore", actor: "user", tool: "learn-undo",
      restoredFrom: result.restoredFrom,
      ...(savedAs ? { snapshot: savedAs } : {}),
    });
    outcome = "restored";
  }
  await appendLine(file, { type: "undo", id, at: now });
  return { entry: { ...entry, undoneAt: now }, outcome, savedAs };
}
