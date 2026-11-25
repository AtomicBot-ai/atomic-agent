import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isCuratableSkillName, SKILL_CURATOR_LIMITS } from "./skill-curator-config.js";

/**
 * Full copies of a skill folder taken before every change, at
 * `<historyDir>/<name>/<version>/`. A version id is the UTC time of the
 * copy (`20261112T101500123Z`), with `-2`, `-3` ... added when two copies
 * land in the same millisecond, so ids sort by age as plain strings.
 */

export interface SkillHistoryDirs {
  /** The live skills folder, `<stateDir>/skills`. */
  skillsDir: string;
  historyDir: string;
  archiveDir: string;
}

const VERSION_RE = /^\d{8}T\d{9}Z(?:-\d+)?$/;

export function versionId(now: number): string {
  return new Date(now).toISOString().replace(/[-:.]/g, "");
}

function assertName(name: string): void {
  if (!isCuratableSkillName(name)) throw new Error(`not a skill folder name: ${JSON.stringify(name)}`);
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Versions of `name`, oldest first. */
export async function listSkillVersions(historyDir: string, name: string): Promise<string[]> {
  assertName(name);
  let entries: string[];
  try {
    entries = await readdir(join(historyDir, name));
  } catch {
    return [];
  }
  return entries.filter((e) => VERSION_RE.test(e)).sort(compareVersions);
}

function compareVersions(a: string, b: string): number {
  const [baseA, nA] = a.split("-");
  const [baseB, nB] = b.split("-");
  if (baseA !== baseB) return baseA! < baseB! ? -1 : 1;
  return Number(nA ?? 1) - Number(nB ?? 1);
}

/**
 * Copy `<from>` into a new version of `name`, then drop the oldest
 * versions past the cap. Returns the version id, or `null` when there is
 * nothing to copy (the skill folder does not exist yet).
 */
export async function snapshotSkillDir(
  historyDir: string,
  name: string,
  from: string,
  now: number = Date.now(),
  keep: number = SKILL_CURATOR_LIMITS.maxSnapshotsPerSkill,
): Promise<string | null> {
  assertName(name);
  if (!(await isDir(from))) return null;
  const base = versionId(now);
  let id = base;
  for (let n = 2; existsSync(join(historyDir, name, id)); n++) id = `${base}-${n}`;
  const dest = join(historyDir, name, id);
  await mkdir(join(historyDir, name), { recursive: true });
  await cp(from, dest, { recursive: true, errorOnExist: true, force: false });
  await pruneSkillVersions(historyDir, name, keep);
  return id;
}

/** Snapshot the live copy of `name` in the skills folder. */
export function snapshotSkill(
  dirs: Pick<SkillHistoryDirs, "skillsDir" | "historyDir">,
  name: string,
  now: number = Date.now(),
): Promise<string | null> {
  assertName(name);
  return snapshotSkillDir(dirs.historyDir, name, join(dirs.skillsDir, name), now);
}

export async function pruneSkillVersions(
  historyDir: string,
  name: string,
  keep: number = SKILL_CURATOR_LIMITS.maxSnapshotsPerSkill,
): Promise<string[]> {
  const versions = await listSkillVersions(historyDir, name);
  const drop = versions.slice(0, Math.max(0, versions.length - Math.max(1, keep)));
  for (const id of drop) await rm(join(historyDir, name, id), { recursive: true, force: true });
  return drop;
}

export interface RestoreSkillResult {
  /** The version put back, or `archive` when the archived copy came back. */
  restoredFrom: string;
  /** Snapshot of the live copy taken before it was replaced, if there was one. */
  snapshot: string | null;
}

/**
 * Put a skill back. Without `version`: the archived copy when the skill
 * was archived, else the newest snapshot. The live copy (if any) is
 * snapshotted first, so a restore can itself be undone.
 */
export async function restoreSkill(
  dirs: SkillHistoryDirs,
  name: string,
  version?: string,
  now: number = Date.now(),
): Promise<RestoreSkillResult> {
  assertName(name);
  const live = join(dirs.skillsDir, name);
  const archived = join(dirs.archiveDir, name);
  let source: string;
  let restoredFrom: string;
  if (version === undefined || version === "archive") {
    if (await isDir(archived)) {
      source = archived;
      restoredFrom = "archive";
    } else if (version === "archive") {
      throw new Error(`skill is not in the archive: ${name}`);
    } else {
      const versions = await listSkillVersions(dirs.historyDir, name);
      const newest = versions.at(-1);
      if (newest === undefined) throw new Error(`no saved versions of skill: ${name}`);
      source = join(dirs.historyDir, name, newest);
      restoredFrom = newest;
    }
  } else {
    if (!VERSION_RE.test(version)) throw new Error(`not a version id: ${JSON.stringify(version)}`);
    source = join(dirs.historyDir, name, version);
    if (!(await isDir(source))) throw new Error(`no version ${version} of skill: ${name}`);
    restoredFrom = version;
  }
  const snapshot = await snapshotSkill(dirs, name, now);
  await rm(live, { recursive: true, force: true });
  await mkdir(dirs.skillsDir, { recursive: true });
  if (restoredFrom === "archive") {
    await rename(source, live);
  } else {
    await cp(source, live, { recursive: true });
  }
  return { restoredFrom, snapshot };
}

/**
 * Move a skill folder to the archive (never deletes). A copy already in
 * the archive under that name is first saved as a history version.
 */
export async function archiveSkill(
  dirs: SkillHistoryDirs,
  name: string,
  now: number = Date.now(),
): Promise<string | null> {
  assertName(name);
  const live = join(dirs.skillsDir, name);
  if (!(await isDir(live))) throw new Error(`skill folder not found: ${name}`);
  const snapshot = await snapshotSkill(dirs, name, now);
  const dest = join(dirs.archiveDir, name);
  if (await isDir(dest)) {
    await snapshotSkillDir(dirs.historyDir, name, dest, now);
    await rm(dest, { recursive: true, force: true });
  }
  await mkdir(dirs.archiveDir, { recursive: true });
  await rename(live, dest);
  return snapshot;
}
