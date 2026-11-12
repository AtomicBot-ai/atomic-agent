import { platform as osPlatform } from "node:os";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { PluginSkillDir } from "../plugins/plugin-runtime.js";
import {
  parseSkillFile,
  SkillManifestError,
  type SkillManifest,
  type SkillPlatform,
} from "./skill-manifest.js";
import { sharedAgentSkillsDir } from "./shared-skills-dir.js";

export type SkillSource = "global" | "project";

export interface SkillRecord {
  manifest: SkillManifest;
  /** Absolute path to the skill root directory. */
  rootDir: string;
  /** Absolute path to the SKILL.md file. */
  manifestPath: string;
  source: SkillSource;
  /** Set for a skill an installed plugin contributes; its name is `plugin:skill`. */
  plugin?: string;
  /** Read from the shared `~/.agents/skills` folder other agents install into (ATO-706). */
  shared?: true;
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
  /**
   * Skill folders contributed by enabled plugins (src/plugins). Read on
   * every load so installing or switching a plugin shows up on refresh.
   * Plugin skills load as user-installed (`global`) skills named
   * `plugin:skill`; a skill the user installed directly keeps its name.
   */
  pluginSkills?: () => readonly PluginSkillDir[];
  /**
   * Home folder whose `.agents/skills` is read as the shared skills folder
   * (see {@link sharedAgentSkillsDir}). Omitted: the env override or the
   * user's home; `null` turns the shared folder off.
   */
  homeDir?: string | null;
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
 * return a deduplicated list. A global skill wins over a project-local one
 * with the same name: a checked-out repository must not be able to replace
 * a skill the user installed (and inherit what that skill is trusted to do,
 * such as an auto-approved setup check). The ignored project copy is
 * reported in `errors` so the shadowing is visible rather than silent.
 * Failures to parse individual skills are collected into `errors` too, so
 * the loader keeps going.
 */
export async function loadSkills(
  options: LoadSkillsOptions,
): Promise<LoadSkillsResult> {
  const errors: Array<{ path: string; error: string }> = [];
  const platform = options.platform ?? osPlatform();
  const globalSkills = await loadFromDir(options.globalDir, "global", errors);
  // When `projectDir` resolves to the exact same absolute path as
  // `globalDir` (e.g. a relative `ATOMIC_AGENT_STATE_DIR=.atomic-agent`
  // run from the repo root makes both `<cwd>/.atomic-agent/skills`), the
  // project scan would re-load every global skill and relabel it
  // `source: "project"` in the merge below — which then blocks global-only
  // operations like uninstall. There is no genuine project skill in that
  // case, so skip the redundant scan and keep the "global" classification.
  const projectIsGlobal =
    !!options.projectDir &&
    resolve(options.projectDir) === resolve(options.globalDir);
  const projectSkills =
    options.projectDir && !projectIsGlobal
      ? await loadFromDir(options.projectDir, "project", errors)
      : [];

  const merged = new Map<string, SkillRecord>();
  for (const s of globalSkills) {
    if (isSkillEligibleForPlatform(s.manifest, platform)) {
      merged.set(s.manifest.name, s);
    }
  }
  if (options.pluginSkills) {
    for (const s of await loadPluginSkills(options.pluginSkills, errors)) {
      if (!isSkillEligibleForPlatform(s.manifest, platform)) continue;
      if (merged.has(s.manifest.name)) {
        errors.push({ path: s.rootDir, error: `skill ${s.manifest.name}: an installed skill already has this name; the plugin copy is ignored` });
        continue;
      }
      merged.set(s.manifest.name, s);
    }
  }
  for (const s of projectSkills) {
    if (!isSkillEligibleForPlatform(s.manifest, platform)) continue;
    const existing = merged.get(s.manifest.name);
    if (existing?.source === "global") {
      errors.push({
        path: s.rootDir,
        error:
          `skill ${s.manifest.name}: a global skill with this name is installed ` +
          `at ${existing.rootDir}; the project copy is ignored`,
      });
      continue;
    }
    merged.set(s.manifest.name, s);
  }
  // Skills installed "for all agents" (~/.agents/skills) only fill names
  // nothing else provides: Atomic global, plugin and project copies win.
  const sharedDir = sharedAgentSkillsDir(options.homeDir);
  if (sharedDir && resolve(sharedDir) !== resolve(options.globalDir)) {
    for (const s of await loadSharedSkills(sharedDir, errors)) {
      if (!isSkillEligibleForPlatform(s.manifest, platform)) continue;
      const existing = merged.get(s.manifest.name);
      if (existing) {
        errors.push({ path: s.rootDir, error: `skill ${s.manifest.name}: using ${existing.manifestPath}; the shared copy is ignored` });
        continue;
      }
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

/**
 * The shared folder is written by other tools, and `npx skills` links
 * skill folders into it, so a skill folder may be a symlink to a folder
 * elsewhere. As for cloud discovery, each skill is confined to its own
 * resolved folder: a SKILL.md that resolves outside it is refused.
 */
async function loadSharedSkills(
  dir: string,
  errors: Array<{ path: string; error: string }>,
): Promise<SkillRecord[]> {
  const records: SkillRecord[] = [];
  for (const found of await loadFromDir(dir, "global", errors)) {
    try {
      const rootDir = await realpath(found.rootDir);
      const manifestPath = await realpath(found.manifestPath);
      const rel = relative(rootDir, manifestPath);
      if (rel !== "SKILL.md") {
        errors.push({ path: found.rootDir, error: `skill ${found.manifest.name}: SKILL.md resolves outside its folder; the shared copy is ignored` });
        continue;
      }
      records.push({ ...found, rootDir, manifestPath, shared: true });
    } catch (err) {
      errors.push({ path: found.rootDir, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return records;
}

async function loadPluginSkills(
  list: () => readonly PluginSkillDir[],
  errors: Array<{ path: string; error: string }>,
): Promise<SkillRecord[]> {
  let dirs: readonly PluginSkillDir[];
  try { dirs = list(); }
  catch (err) {
    errors.push({ path: "plugins", error: err instanceof Error ? err.message : String(err) });
    return [];
  }
  const records: SkillRecord[] = [];
  for (const entry of dirs) {
    const manifestPath = join(entry.dir, "SKILL.md");
    try {
      const parsed = parseSkillFile(await readFile(manifestPath, "utf8"), { fallbackName: basename(entry.dir) });
      const name = entry.rootSkill ? entry.plugin : `${entry.plugin}:${parsed.manifest.name}`;
      records.push({ manifest: { ...parsed.manifest, name }, rootDir: entry.dir, manifestPath, source: "global", plugin: entry.plugin });
    } catch (err) {
      errors.push({ path: entry.dir, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return records;
}
