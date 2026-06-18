import { platform as osPlatform } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  parseSkillFile,
  SkillManifestError,
  type SkillManifest,
  type SkillPlatform,
} from "./skill-manifest.js";

export type SkillSource = "global" | "project";

export interface SkillRecord {
  manifest: SkillManifest;
  /** Absolute path to the skill root directory. */
  rootDir: string;
  /** Absolute path to the SKILL.md file. */
  manifestPath: string;
  source: SkillSource;
}

export interface LoadSkillsOptions {
  globalDir: string;
  projectDir: string | null;
  /**
   * OS to gate skills against (matched against each manifest's optional
   * `platforms` allowlist). Defaults to the live `os.platform()`;
   * injectable so tests can exercise the filter deterministically.
   */
  platform?: NodeJS.Platform;
}

/**
 * A skill is eligible when it declares no `platforms` allowlist (cross-
 * platform) or when the allowlist includes the current OS.
 */
export function isSkillEligibleForPlatform(
  manifest: SkillManifest,
  platform: NodeJS.Platform,
): boolean {
  if (manifest.platforms === undefined) return true;
  return manifest.platforms.includes(platform as SkillPlatform);
}

export interface LoadSkillsResult {
  skills: SkillRecord[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * Scan global and project skill directories, parse each SKILL.md, and
 * return a deduplicated list. Project-local skills shadow global ones with
 * the same name. Failures to parse individual skills are collected into
 * `errors` so the loader keeps going.
 */
export async function loadSkills(
  options: LoadSkillsOptions,
): Promise<LoadSkillsResult> {
  const errors: Array<{ path: string; error: string }> = [];
  const platform = options.platform ?? osPlatform();
  const globalSkills = await loadFromDir(options.globalDir, "global", errors);
  const projectSkills = options.projectDir
    ? await loadFromDir(options.projectDir, "project", errors)
    : [];

  const merged = new Map<string, SkillRecord>();
  for (const s of globalSkills) {
    if (isSkillEligibleForPlatform(s.manifest, platform)) {
      merged.set(s.manifest.name, s);
    }
  }
  for (const s of projectSkills) {
    if (isSkillEligibleForPlatform(s.manifest, platform)) {
      merged.set(s.manifest.name, s);
    }
  }

  return {
    skills: Array.from(merged.values()).sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name),
    ),
    errors,
  };
}

async function loadFromDir(
  dir: string,
  source: SkillSource,
  errors: Array<{ path: string; error: string }>,
): Promise<SkillRecord[]> {
  const absoluteDir = resolve(dir);
  let entries: string[];
  try {
    entries = await readdir(absoluteDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    errors.push({
      path: absoluteDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const records: SkillRecord[] = [];
  for (const name of entries) {
    const rootDir = join(absoluteDir, name);
    try {
      const info = await stat(rootDir);
      if (!info.isDirectory()) continue;
      const manifestPath = join(rootDir, "SKILL.md");
      const manifestStat = await stat(manifestPath).catch(() => null);
      if (!manifestStat?.isFile()) continue;
      const content = await readFile(manifestPath, "utf8");
      const parsed = parseSkillFile(content);
      records.push({
        manifest: parsed.manifest,
        rootDir,
        manifestPath,
        source,
      });
    } catch (err) {
      const message =
        err instanceof SkillManifestError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      errors.push({ path: rootDir, error: message });
    }
  }
  return records;
}
