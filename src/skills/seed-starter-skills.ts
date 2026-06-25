import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isSkillEligibleForPlatform } from "./skill-loader.js";
import { parseSkillFile } from "./skill-manifest.js";

export interface SeedStarterSkillsLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
}

export interface SeedStarterSkillsOptions {
  globalSkillsDir: string;
  logger?: SeedStarterSkillsLogger;
  /**
   * OS to gate starter skills against. Defaults to the live
   * `os.platform()`; injectable for tests. A starter whose SKILL.md
   * declares a `platforms` allowlist excluding this OS is skipped.
   */
  platform?: NodeJS.Platform;
}

export interface SeedStarterSkillsResult {
  sourceDir: string | null;
  /** Skill folder names copied from the starter pack this run (replaces any existing dir). */
  installed: string[];
  /** Tombstoned starter-skill folders pruned from `globalSkillsDir` this run. */
  removed: string[];
}

/**
 * Starter-skill folder names that were once bundled but have since been
 * dropped. The seeder is otherwise additive (copy + replace same-name), so a
 * removed starter would linger in every existing `<stateDir>/skills/` forever.
 * Each name here is deleted from `globalSkillsDir` on boot if present. Safe
 * because starter-skill names are reserved by contract — users must not reuse
 * them for custom work (they are replaced on every boot anyway).
 */
const REMOVED_STARTER_SKILLS: readonly string[] = [
  "ddgr-web-search",
  "exa-web-search",
];

function markerPath(root: string): string {
  return join(root, "skill-creator", "SKILL.md");
}

/**
 * Resolve the packaged `starter-skills/` tree.
 *
 * Node SEA: `import.meta.url` is a `file:` URL for **process.execPath** (the
 * blob binary), so `dirname(import.meta.url)` is the bundle directory and
 * skills ship as `<bundle>/starter-skills/` (see `package-bundle.ts`).
 *
 * npm / `node dist/...`: this module lives under `dist/skills/` or
 * `src/skills/`, so we also try parent and grandparent `starter-skills/`.
 */
export function resolveStarterSkillsSourceDir(): string | null {
  const env = process.env.ATOMIC_AGENT_STARTER_SKILLS_DIR?.trim();
  if (env && existsSync(markerPath(env))) {
    return env;
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "starter-skills"),
    join(moduleDir, "..", "starter-skills"),
    join(moduleDir, "..", "..", "starter-skills"),
  ];

  try {
    candidates.push(join(dirname(process.execPath), "starter-skills"));
  } catch {
    // ignore
  }

  for (const dir of candidates) {
    if (existsSync(markerPath(dir))) {
      return dir;
    }
  }

  return null;
}

/**
 * Copy built-in starter skill folders into `globalSkillsDir`, replacing any
 * existing directory with the same name so upgrades refresh SKILL bodies.
 */
export async function seedStarterSkillsIfMissing(
  options: SeedStarterSkillsOptions,
): Promise<SeedStarterSkillsResult> {
  const logger = options.logger;
  const platform = options.platform ?? osPlatform();
  const sourceDir = resolveStarterSkillsSourceDir();
  const installed: string[] = [];
  const removed = await pruneRemovedStarterSkills(
    options.globalSkillsDir,
    logger,
  );

  if (sourceDir === null) {
    logger?.debug("starter-skills: source tree not found; skipping seed", {});
    return { sourceDir: null, installed, removed };
  }

  let names: string[];
  try {
    names = await readdir(sourceDir);
  } catch (err) {
    logger?.debug("starter-skills: cannot read source dir; skipping seed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { sourceDir, installed, removed };
  }

  await mkdir(options.globalSkillsDir, { recursive: true });

  for (const name of names) {
    if (name === "README.md") continue;
    const srcPath = join(sourceDir, name);
    let st;
    try {
      st = await stat(srcPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const manifestPath = join(srcPath, "SKILL.md");
    if (!existsSync(manifestPath)) continue;

    // Skip starters whose manifest excludes the current OS (e.g. the
    // apple-* skills on Linux). A manifest that fails to parse is left
    // to the loader to report; here we fall through and copy it so the
    // failure surfaces consistently.
    if (!isStarterEligible(manifestPath, platform)) {
      logger?.debug("starter-skills: skipping platform-mismatched starter", {
        skill: name,
        platform,
      });
      continue;
    }

    const destPath = join(options.globalSkillsDir, name);
    if (existsSync(destPath)) {
      await rm(destPath, { recursive: true, force: true });
    }

    await cp(srcPath, destPath, { recursive: true });
    installed.push(name);
  }

  if (installed.length > 0) {
    logger?.info("starter-skills: installed global skills", {
      skills: installed,
      sourceDir,
    });
  }

  return { sourceDir, installed, removed };
}

/**
 * Decide whether a starter skill should be seeded on `platform` by
 * reading its SKILL.md `platforms` allowlist. A manifest that cannot be
 * read or parsed is treated as eligible (fail-open) so the loader is the
 * single place that reports a malformed manifest.
 */
function isStarterEligible(
  manifestPath: string,
  platform: NodeJS.Platform,
): boolean {
  try {
    const content = readFileSync(manifestPath, "utf8");
    const parsed = parseSkillFile(content);
    return isSkillEligibleForPlatform(parsed.manifest, platform);
  } catch {
    return true;
  }
}

/**
 * Delete tombstoned starter-skill folders from `globalSkillsDir`. Returns the
 * names actually removed this run. A missing folder is a silent no-op so the
 * prune is idempotent across boots.
 */
async function pruneRemovedStarterSkills(
  globalSkillsDir: string,
  logger?: SeedStarterSkillsLogger,
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of REMOVED_STARTER_SKILLS) {
    const destPath = join(globalSkillsDir, name);
    if (!existsSync(destPath)) continue;
    try {
      await rm(destPath, { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      logger?.debug("starter-skills: failed to prune removed skill", {
        skill: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (removed.length > 0) {
    logger?.info("starter-skills: pruned removed global skills", {
      skills: removed,
    });
  }
  return removed;
}
