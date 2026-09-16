import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { installSkill } from "../skills/skill-installer.js";
import { parseSkillFile } from "../skills/skill-manifest.js";
import type { ImportItemResult } from "./import-report.js";

/**
 * The skills domain shared by the Pi-family importers, mirroring the
 * Claude Code importer's behaviour: parse each source dir's SKILL.md,
 * install a directory copy under the manifest name, skip byte-identical
 * installs, and flag differing ones as conflicts unless `overwrite`.
 *
 * One addition the flat one-level sources never needed: Pi's recursive
 * skills tree can carry the same manifest name twice, so the first dir
 * to claim a destination in a run wins and later claimants are reported
 * instead of racing it — a byte-identical twin skips, a differing one
 * conflicts (never installed, whatever `overwrite` says). Without the
 * guard a preview would count both as migrated while an execute
 * manufactured a conflict — or, with `overwrite`, silently last-wrote.
 */
export interface ImportSkillDirsInput<Kind extends string> {
  /** The report kind every emitted item carries. */
  kind: Kind;
  /** Source skill dirs; `name` labels the report row. */
  skills: readonly { name: string; dir: string }[];
  /** Scanned root, named by the empty-domain skip reason. */
  skillsDir: string;
  /** Root the imported skills are installed under. */
  globalSkillsDir: string;
  /** When false, compute the items without writing anything. */
  execute: boolean;
  /** Overwrite a differing installed skill instead of conflicting. */
  overwrite: boolean;
  /** Report sink the items are appended to. */
  items: ImportItemResult<Kind>[];
}

export async function importSkillDirs<Kind extends string>(
  input: ImportSkillDirsInput<Kind>,
): Promise<void> {
  if (input.skills.length === 0) {
    input.items.push({
      kind: input.kind,
      status: "skipped",
      reason: `no skills found in ${input.skillsDir}`,
    });
    return;
  }
  /** Manifest name -> the source dir that claimed it in this run. */
  const claimed = new Map<string, { dir: string; source: string }>();
  for (const skill of input.skills) {
    const base: ImportItemResult<Kind> = {
      kind: input.kind,
      source: skill.name,
      status: "migrated",
    };
    let manifestName: string;
    try {
      const manifestRaw = readFileSync(join(skill.dir, "SKILL.md"), "utf8");
      manifestName = parseSkillFile(manifestRaw).manifest.name;
    } catch (err) {
      input.items.push({
        ...base,
        status: "error",
        reason: `invalid SKILL.md: ${errorMessage(err)}`,
      });
      continue;
    }
    const prior = claimed.get(manifestName);
    if (prior) {
      input.items.push({
        ...base,
        destination: manifestName,
        ...(manifestsMatch(skill.dir, prior.dir)
          ? { status: "skipped" as const, reason: `duplicate of ${prior.source}` }
          : {
              status: "conflict" as const,
              reason: `same skill name as ${prior.source} with a different SKILL.md; not imported`,
            }),
      });
      continue;
    }
    claimed.set(manifestName, { dir: skill.dir, source: skill.name });
    const destination = join(input.globalSkillsDir, manifestName);
    const exists = existsSync(destination);
    if (exists) {
      if (manifestsMatch(skill.dir, destination)) {
        input.items.push({
          ...base,
          destination: manifestName,
          status: "skipped",
          reason: "already installed",
        });
        continue;
      }
      if (!input.overwrite) {
        input.items.push({
          ...base,
          destination: manifestName,
          status: "conflict",
          reason: "skill exists with a different SKILL.md; use --overwrite",
        });
        continue;
      }
    }
    if (input.execute) {
      try {
        await installSkill({
          sourceDir: skill.dir,
          targetRoot: input.globalSkillsDir,
          force: exists,
        });
      } catch (err) {
        input.items.push({
          ...base,
          status: "error",
          reason: errorMessage(err),
        });
        continue;
      }
    }
    input.items.push({
      ...base,
      destination: manifestName,
      ...(exists ? { reason: "overwritten" } : {}),
    });
  }
}

/** Whether two skill dirs carry byte-identical `SKILL.md` manifests. */
function manifestsMatch(sourceDir: string, targetDir: string): boolean {
  try {
    return (
      readFileSync(join(sourceDir, "SKILL.md"), "utf8") ===
      readFileSync(join(targetDir, "SKILL.md"), "utf8")
    );
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
