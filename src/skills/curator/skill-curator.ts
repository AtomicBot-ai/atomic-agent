import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./json-file.js";
import { appendSkillChange } from "./skill-change-log.js";
import {
  DAY_MS,
  isCuratableSkillName,
  SKILL_CURATOR_LIMITS,
  type SkillCuratorPaths,
} from "./skill-curator-config.js";
import { archiveSkill } from "./skill-history.js";
import type { SkillUsageFile } from "./skill-usage-ledger.js";
import { SkillUsageLedger } from "./skill-usage-ledger.js";

/**
 * The skill curator (ATO-580): skills the agent wrote for itself and then
 * stopped using go stale after 14 days and move to the archive after 30.
 * Only agent-learned skills are candidates; a starter, a hub or plugin
 * install and anything a person wrote has no recorded agent origin and is
 * never touched. A skill a recurring task mentions is kept however long it
 * sits unused, since the task will need it. Nothing is deleted: archived
 * folders sit in `<stateDir>/skills-archive/` and `skill restore` brings
 * them back.
 */

export type CuratorVerdict =
  | { name: string; action: "keep"; reason: CuratorKeepReason }
  | { name: string; action: "stale"; idleDays: number }
  | { name: string; action: "archive"; idleDays: number };

export type CuratorKeepReason =
  | "not-agent-learned"
  | "starter"
  | "cron-referenced"
  | "recently-used"
  | "no-timestamp";

export interface CuratorSelectInput {
  /** Folder names present in the skills folder. */
  installed: readonly string[];
  usage: SkillUsageFile;
  starterNames: ReadonlySet<string>;
  /** Text of each active recurring task; a skill named in one is kept. */
  cronTexts: readonly string[];
  now: number;
  staleAfterDays?: number;
  archiveAfterDays?: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `name` appears in `text` as a whole word (not inside a longer name). */
export function mentionsSkill(text: string, name: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(name)}($|[^A-Za-z0-9_-])`, "i");
  return re.test(text);
}

/** Pure selection: what the curator would do with each installed skill. */
export function selectCuratorActions(input: CuratorSelectInput): CuratorVerdict[] {
  const staleDays = input.staleAfterDays ?? SKILL_CURATOR_LIMITS.staleAfterDays;
  const archiveDays = input.archiveAfterDays ?? SKILL_CURATOR_LIMITS.archiveAfterDays;
  const out: CuratorVerdict[] = [];
  for (const name of [...input.installed].sort()) {
    const entry = input.usage.skills[name];
    if (input.starterNames.has(name)) {
      out.push({ name, action: "keep", reason: "starter" });
      continue;
    }
    if (entry?.origin !== "agent") {
      out.push({ name, action: "keep", reason: "not-agent-learned" });
      continue;
    }
    if (input.cronTexts.some((text) => mentionsSkill(text, name))) {
      out.push({ name, action: "keep", reason: "cron-referenced" });
      continue;
    }
    const since = Math.max(entry.lastUsedAt ?? 0, entry.createdAt ?? 0, entry.restoredAt ?? 0);
    // No timestamp at all: we cannot tell how long it sat; leave it.
    if (since === 0) {
      out.push({ name, action: "keep", reason: "no-timestamp" });
      continue;
    }
    const idleDays = Math.floor((input.now - since) / DAY_MS);
    if (idleDays >= archiveDays) out.push({ name, action: "archive", idleDays });
    else if (idleDays >= staleDays) out.push({ name, action: "stale", idleDays });
    else out.push({ name, action: "keep", reason: "recently-used" });
  }
  return out;
}

export interface CuratorState {
  lastRunAt?: number;
  stale: string[];
}

export async function readCuratorState(file: string): Promise<CuratorState> {
  const raw = await readJsonFile(file);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { stale: [] };
  const obj = raw as Record<string, unknown>;
  const stale = Array.isArray(obj.stale) ? obj.stale.filter((s): s is string => typeof s === "string") : [];
  return typeof obj.lastRunAt === "number" ? { lastRunAt: obj.lastRunAt, stale } : { stale };
}

export interface RunSkillCuratorOptions {
  skillsDir: string;
  paths: SkillCuratorPaths;
  starterNames: ReadonlySet<string>;
  cronTexts: readonly string[];
  now?: number;
  /** Run even if the last run was less than `runEveryDays` ago (the CLI). */
  force?: boolean;
  /** Report what would happen without moving anything. */
  dryRun?: boolean;
}

export interface RunSkillCuratorResult {
  /** False when the weekly gate skipped the run. */
  ran: boolean;
  verdicts: CuratorVerdict[];
  archived: string[];
  stale: string[];
  errors: Array<{ name: string; error: string }>;
}

async function listSkillFolders(skillsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!isCuratableSkillName(name)) continue;
    try {
      if ((await stat(join(skillsDir, name))).isDirectory()) out.push(name);
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

export async function runSkillCurator(options: RunSkillCuratorOptions): Promise<RunSkillCuratorResult> {
  const now = options.now ?? Date.now();
  const { paths } = options;
  const state = await readCuratorState(paths.stateFile);
  const gateMs = SKILL_CURATOR_LIMITS.runEveryDays * DAY_MS;
  if (!options.force && state.lastRunAt !== undefined && now - state.lastRunAt < gateMs) {
    return { ran: false, verdicts: [], archived: [], stale: state.stale, errors: [] };
  }
  const verdicts = selectCuratorActions({
    installed: await listSkillFolders(options.skillsDir),
    usage: await new SkillUsageLedger(paths.usageFile).read(),
    starterNames: options.starterNames,
    cronTexts: options.cronTexts,
    now,
  });
  const stale = verdicts.filter((v) => v.action === "stale").map((v) => v.name);
  const archived: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  if (options.dryRun) return { ran: true, verdicts, archived, stale, errors };

  const dirs = { skillsDir: options.skillsDir, historyDir: paths.historyDir, archiveDir: paths.archiveDir };
  for (const v of verdicts) {
    if (v.action !== "archive") continue;
    try {
      const snapshot = await archiveSkill(dirs, v.name, now);
      archived.push(v.name);
      await appendSkillChange(paths.changeLog, {
        at: now, name: v.name, action: "archive", actor: "curator", ...(snapshot ? { snapshot } : {}),
      });
    } catch (err) {
      errors.push({ name: v.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const previouslyStale = new Set(state.stale);
  for (const name of stale) {
    if (previouslyStale.has(name)) continue;
    await appendSkillChange(paths.changeLog, { at: now, name, action: "stale", actor: "curator" });
  }
  await writeJsonFile(paths.stateFile, { lastRunAt: now, stale });
  return { ran: true, verdicts, archived, stale, errors };
}
