import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SeedStarterSkillsLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
}

export interface SeedStarterSkillsOptions {
  globalSkillsDir: string;
  logger?: SeedStarterSkillsLogger;
}

export interface SeedStarterSkillsResult {
  sourceDir: string | null;
  /** Skill folder names copied from the starter pack this run (replaces any existing dir). */
  installed: string[];
}

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
  const sourceDir = resolveStarterSkillsSourceDir();
  const installed: string[] = [];

  if (sourceDir === null) {
    logger?.debug("starter-skills: source tree not found; skipping seed", {});
    return { sourceDir: null, installed };
  }

  let names: string[];
  try {
    names = await readdir(sourceDir);
  } catch (err) {
    logger?.debug("starter-skills: cannot read source dir; skipping seed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { sourceDir, installed };
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
    if (!existsSync(join(srcPath, "SKILL.md"))) continue;

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

  return { sourceDir, installed };
}
