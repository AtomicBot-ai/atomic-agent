import { existsSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config/index.js";
import {
  appendSkillChange,
  isCuratableSkillName,
  listSkillVersions,
  readSkillChanges,
  restoreSkill,
  runSkillCurator,
  SkillChangeRecorder,
  skillCuratorPaths,
  type CuratorVerdict,
  type SkillChangeEntry,
} from "../skills/curator/index.js";
import { listStarterSkillNames } from "../skills/seed-starter-skills.js";
import { TaskStore } from "../tasks/task-store.js";

/**
 * `skill history`, `skill restore` and `skill curate` (ATO-580): the
 * operator's view of the skill change log, the undo, and a hand-run of
 * the curator.
 */

export const SKILL_HISTORY_HELP_LINES = [
  "  history [name]             Show the skill change log (create/edit/archive/restore) and saved versions",
  "  restore <name> [--version <id>|archive]",
  "                             Put a skill back from the archive or a saved version (the current copy is saved first)",
  "  curate [--dry-run]         Archive agent-learned skills unused for 30 days now (never starter, hub or your own)",
];

function dirsFor(stateDir: string, skillsDir: string) {
  const paths = skillCuratorPaths(stateDir);
  return { paths, dirs: { skillsDir, historyDir: paths.historyDir, archiveDir: paths.archiveDir } };
}

function formatEntry(e: SkillChangeEntry): string {
  const extra = [
    e.snapshot ? `saved ${e.snapshot}` : null,
    e.restoredFrom ? `from ${e.restoredFrom}` : null,
    e.tool ? `via ${e.tool}` : null,
  ].filter((x): x is string => x !== null);
  return `${new Date(e.at).toISOString()}\t${e.name}\t${e.action}\t${e.actor}${extra.length ? `\t${extra.join(", ")}` : ""}`;
}

export async function handleSkillHistory(args: string[]): Promise<number> {
  const name = args.find((a) => !a.startsWith("-"));
  if (name !== undefined && !isCuratableSkillName(name)) {
    process.stderr.write(`not a skill name: ${name}\n`);
    return 2;
  }
  const config = getConfig();
  const { paths } = dirsFor(config.paths.stateDir, config.paths.globalSkillsDir);
  const changes = await readSkillChanges(paths.changeLog, name);
  const shown = name === undefined ? changes.slice(-50) : changes;
  if (shown.length === 0) process.stdout.write(name ? `(no changes recorded for ${name})\n` : "(no skill changes recorded)\n");
  for (const e of shown) process.stdout.write(`${formatEntry(e)}\n`);
  if (name !== undefined) {
    const versions = await listSkillVersions(paths.historyDir, name);
    process.stdout.write(versions.length ? `versions: ${versions.join(" ")}\n` : "versions: (none)\n");
    if (existsSync(join(paths.archiveDir, name))) process.stdout.write(`archived: yes (atomic-agent skill restore ${name})\n`);
    const usage = await new SkillChangeRecorder(config.paths.globalSkillsDir, paths).ledger.get(name);
    if (usage) {
      const last = usage.lastUsedAt ? new Date(usage.lastUsedAt).toISOString() : "never";
      process.stdout.write(`uses: ${usage.useCount}, last used: ${last}${usage.origin ? `, learned by the ${usage.origin}` : ""}\n`);
    }
  }
  return 0;
}

export async function handleSkillRestore(args: string[]): Promise<number> {
  const name = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--version");
  const versionIndex = args.indexOf("--version");
  const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
  if (!name || (versionIndex >= 0 && (!version || version.startsWith("-")))) {
    process.stderr.write("usage: atomic-agent skill restore <name> [--version <id>|archive]\n");
    return 2;
  }
  if (!isCuratableSkillName(name)) {
    process.stderr.write(`not a skill name: ${name}\n`);
    return 2;
  }
  const config = getConfig();
  const { paths, dirs } = dirsFor(config.paths.stateDir, config.paths.globalSkillsDir);
  const now = Date.now();
  const result = await restoreSkill(dirs, name, version, now);
  await new SkillChangeRecorder(config.paths.globalSkillsDir, paths).ledger.markRestored(name, now);
  await appendSkillChange(paths.changeLog, {
    at: now,
    name,
    action: "restore",
    actor: "user",
    restoredFrom: result.restoredFrom,
    ...(result.snapshot ? { snapshot: result.snapshot } : {}),
  });
  process.stdout.write(
    `restored ${name} from ${result.restoredFrom}${result.snapshot ? ` (previous copy saved as ${result.snapshot})` : ""}\n`,
  );
  return 0;
}

function formatVerdict(v: CuratorVerdict): string | null {
  if (v.action === "archive") return `archive\t${v.name}\tunused ${v.idleDays} days`;
  if (v.action === "stale") return `stale\t${v.name}\tunused ${v.idleDays} days`;
  if (v.reason === "cron-referenced") return `keep\t${v.name}\tnamed by a recurring task`;
  return null;
}

function cronTextsFromStore(dbFile: string): string[] {
  if (!existsSync(dbFile)) return [];
  const store = new TaskStore({ dbFile });
  try {
    return store
      .list({ status: ["pending", "running", "blocked"], limit: 10_000 })
      .filter((t) => t.recurring)
      .map((t) => t.userMessage);
  } finally {
    store.close();
  }
}

export async function handleSkillCurate(args: string[]): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const config = getConfig();
  const { paths } = dirsFor(config.paths.stateDir, config.paths.globalSkillsDir);
  const result = await runSkillCurator({
    skillsDir: config.paths.globalSkillsDir,
    paths,
    starterNames: await listStarterSkillNames(),
    cronTexts: cronTextsFromStore(config.paths.tasksDbFile),
    force: true,
    dryRun,
  });
  const lines = result.verdicts.map(formatVerdict).filter((l): l is string => l !== null);
  if (lines.length === 0) process.stdout.write("(nothing to archive)\n");
  for (const line of lines) process.stdout.write(`${dryRun ? "would " : ""}${line}\n`);
  for (const e of result.errors) process.stderr.write(`WARN: ${e.name}: ${e.error}\n`);
  if (!dryRun && result.archived.length > 0) {
    process.stdout.write(`archived ${result.archived.length}; undo with: atomic-agent skill restore <name>\n`);
  }
  return result.errors.length > 0 ? 1 : 0;
}

/** Snapshot a skill before `skill uninstall` removes it, and log the removal. */
export async function recordUserSkillRemoval<T>(name: string, remove: () => Promise<T>): Promise<T> {
  const config = getConfig();
  if (!isCuratableSkillName(name)) return remove();
  const recorder = new SkillChangeRecorder(config.paths.globalSkillsDir, skillCuratorPaths(config.paths.stateDir));
  const before = await recorder.before(name).catch(() => null);
  const result = await remove();
  if (before) await recorder.after(before, "user").catch(() => undefined);
  return result;
}
