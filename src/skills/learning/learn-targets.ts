import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readSkillLock } from "../hub/skill-lock.js";
import type { SkillRecord } from "../skill-loader.js";

/**
 * Which skills the experience review may touch (ATO-67). Only skills the
 * operator's own agent keeps in the global folder: never a starter (it is
 * re-seeded and owned by the release), a hub install (`skill update`
 * owns it), a plugin's, the shared `~/.agents/skills` folder or a
 * project's (the repository owns those).
 */

export interface LearnTargetInput {
  /** Every parsed skill, including disabled ones (`SkillRegistry.listAll`). */
  records: readonly SkillRecord[];
  starterNames: ReadonlySet<string>;
  globalSkillsDir: string;
  archiveDir: string;
}

async function folderNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Every name a new learned skill may not take. */
export async function takenSkillNames(input: LearnTargetInput): Promise<Set<string>> {
  const names = new Set<string>(input.starterNames);
  for (const record of input.records) names.add(record.manifest.name);
  for (const name of await folderNames(input.globalSkillsDir)) names.add(name);
  // An archived learned skill can come back with `skill restore`.
  for (const name of await folderNames(input.archiveDir)) names.add(name);
  return names;
}

/** Whether the review may rewrite this skill. */
export async function isPatchableSkill(record: SkillRecord, input: LearnTargetInput): Promise<boolean> {
  if (record.source !== "global" || record.plugin !== undefined || record.shared === true) return false;
  const name = record.manifest.name;
  if (input.starterNames.has(name)) return false;
  if (resolve(record.rootDir) !== resolve(join(input.globalSkillsDir, name))) return false;
  return (await readSkillLock(record.rootDir)) === null;
}

/** The used skills, in order, that the review may patch. */
export async function patchableSkillNames(used: readonly string[], input: LearnTargetInput): Promise<string[]> {
  const out: string[] = [];
  for (const name of used) {
    const record = input.records.find((r) => r.manifest.name === name);
    if (record && (await isPatchableSkill(record, input))) out.push(name);
  }
  return out;
}
