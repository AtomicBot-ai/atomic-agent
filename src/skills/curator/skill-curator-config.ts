import { join } from "node:path";

/**
 * Thresholds for the skill curator (ATO-580). Code constants rather than
 * config keys: the curator is new and off by default, so the numbers are
 * kept in one place until the behaviour is settled.
 */
export const SKILL_CURATOR_LIMITS = {
  /** An agent-learned skill unused this long is marked stale (still loaded). */
  staleAfterDays: 14,
  /** An agent-learned skill unused this long is moved to the archive folder. */
  archiveAfterDays: 30,
  /** The automatic pass runs at most once per this many days. */
  runEveryDays: 7,
  /** Snapshots kept per skill in the history folder; the oldest go first. */
  maxSnapshotsPerSkill: 10,
} as const;

/**
 * Whether the runtime runs the curator on its own at boot. Off: archiving
 * a skill nobody asked to archive is a product decision, and nothing in
 * the agent did that before. `ATOMIC_AGENT_SKILL_CURATOR=1` turns it on;
 * `atomic-agent skill curate` runs it by hand either way.
 */
export const SKILL_CURATOR_AUTO_RUN_DEFAULT = false;

export function skillCuratorAutoRunEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.ATOMIC_AGENT_SKILL_CURATOR?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return SKILL_CURATOR_AUTO_RUN_DEFAULT;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Where the curator keeps its files, all under the state directory. */
export interface SkillCuratorPaths {
  /** Use count, last use and origin per skill (JSON). */
  usageFile: string;
  /** `<historyDir>/<name>/<version>/` holds a full copy of the skill folder. */
  historyDir: string;
  /** Append-only change log, one JSON object per line. */
  changeLog: string;
  /** Archived skill folders; outside the skills folder so they do not load. */
  archiveDir: string;
  /** Last automatic run and the current stale list (JSON). */
  stateFile: string;
}

export function skillCuratorPaths(stateDir: string): SkillCuratorPaths {
  const historyDir = join(stateDir, "skills-history");
  return {
    usageFile: join(stateDir, "skills-usage.json"),
    historyDir,
    changeLog: join(historyDir, "changes.jsonl"),
    archiveDir: join(stateDir, "skills-archive"),
    stateFile: join(stateDir, "skills-curator.json"),
  };
}

/**
 * A skill folder name the curator will touch: one path segment, no dots
 * at the start, nothing that could climb out of the skills folder.
 */
export function isCuratableSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !name.includes("..");
}
