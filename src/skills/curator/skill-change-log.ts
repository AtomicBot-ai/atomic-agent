import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SkillChangeActor = "agent" | "user" | "curator";
export type SkillChangeAction =
  | "create"
  | "edit"
  | "delete"
  | "stale"
  | "archive"
  | "restore";

export interface SkillChangeEntry {
  /** Epoch ms. */
  at: number;
  name: string;
  action: SkillChangeAction;
  actor: SkillChangeActor;
  /** The snapshot taken just before this change, when there was one. */
  snapshot?: string;
  /** For a restore: the version that was put back (`archive` for the archive copy). */
  restoredFrom?: string;
  /** The tool that made the change, for agent edits. */
  tool?: string;
}

const ACTIONS = new Set<SkillChangeAction>(["create", "edit", "delete", "stale", "archive", "restore"]);
const ACTORS = new Set<SkillChangeActor>(["agent", "user", "curator"]);

/** Append one change. The log is never rewritten. */
export async function appendSkillChange(
  file: string,
  entry: SkillChangeEntry,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

function parseLine(line: string): SkillChangeEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.at !== "number" || typeof obj.name !== "string") return null;
  if (!ACTIONS.has(obj.action as SkillChangeAction)) return null;
  if (!ACTORS.has(obj.actor as SkillChangeActor)) return null;
  const entry: SkillChangeEntry = {
    at: obj.at,
    name: obj.name,
    action: obj.action as SkillChangeAction,
    actor: obj.actor as SkillChangeActor,
  };
  if (typeof obj.snapshot === "string") entry.snapshot = obj.snapshot;
  if (typeof obj.restoredFrom === "string") entry.restoredFrom = obj.restoredFrom;
  if (typeof obj.tool === "string") entry.tool = obj.tool;
  return entry;
}

/** Read the log, oldest first; unreadable lines are skipped. */
export async function readSkillChanges(
  file: string,
  name?: string,
): Promise<SkillChangeEntry[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: SkillChangeEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseLine(line);
    if (entry === null) continue;
    if (name !== undefined && entry.name !== name) continue;
    out.push(entry);
  }
  return out;
}
