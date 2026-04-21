import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSkillFile } from "./skill-manifest.js";
import type { SkillManifest } from "./skill-manifest.js";

export interface InstallSkillOptions {
  sourceDir: string;
  targetRoot: string;
  force?: boolean;
}

export interface InstallSkillResult {
  manifest: SkillManifest;
  installedAt: string;
}

export class SkillInstallError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "source_missing"
      | "manifest_missing"
      | "already_installed"
      | "invalid_manifest",
  ) {
    super(message);
    this.name = "SkillInstallError";
  }
}

/**
 * Install a skill by copying its directory into the target skills root.
 * We parse and validate the manifest first so we never leave a broken
 * skill on disk. `force: true` overwrites an existing entry with the
 * same name.
 */
export async function installSkill(
  options: InstallSkillOptions,
): Promise<InstallSkillResult> {
  const sourceDir = resolve(options.sourceDir);
  const sourceInfo = await stat(sourceDir).catch(() => null);
  if (!sourceInfo?.isDirectory()) {
    throw new SkillInstallError(
      `source is not a directory: ${sourceDir}`,
      "source_missing",
    );
  }
  const manifestPath = join(sourceDir, "SKILL.md");
  const manifestInfo = await stat(manifestPath).catch(() => null);
  if (!manifestInfo?.isFile()) {
    throw new SkillInstallError(
      `SKILL.md missing at ${manifestPath}`,
      "manifest_missing",
    );
  }
  const content = await readFile(manifestPath, "utf8");
  let manifest: SkillManifest;
  try {
    manifest = parseSkillFile(content).manifest;
  } catch (err) {
    throw new SkillInstallError(
      `invalid SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
      "invalid_manifest",
    );
  }

  const targetRoot = resolve(options.targetRoot);
  await mkdir(targetRoot, { recursive: true });
  const installedAt = join(targetRoot, manifest.name);
  const exists = await stat(installedAt).catch(() => null);
  if (exists && !options.force) {
    throw new SkillInstallError(
      `skill "${manifest.name}" already installed at ${installedAt} (use --force to overwrite)`,
      "already_installed",
    );
  }
  if (exists) {
    await rm(installedAt, { recursive: true, force: true });
  }
  await cp(sourceDir, installedAt, { recursive: true });
  return { manifest, installedAt };
}

export async function uninstallSkill(
  targetRoot: string,
  name: string,
): Promise<{ removed: boolean; path: string }> {
  const path = join(resolve(targetRoot), name);
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) return { removed: false, path };
  await rm(path, { recursive: true, force: true });
  return { removed: true, path };
}
