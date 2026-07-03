import { join } from "node:path";

import {
  ensureUserConfigFileSync,
  resetConfigCache,
  writeUserConfigFileSync,
  type UserConfigFile,
} from "../config/index.js";
import {
  installSkill,
  SkillInstallError,
  uninstallSkill,
  type SkillManifest,
  type SkillRecord,
  type SkillSource,
} from "../skills/index.js";

import { RuntimeApiError } from "./runtime-api-error.js";

export interface SkillServiceDeps {
  skillRegistry: {
    listAll(): Array<{ record: SkillRecord; disabled: boolean }>;
    errors(): ReadonlyArray<{ path: string; error: string }>;
    setDisabledNames(names: Iterable<string>): void;
  };
  refreshSkills(): Promise<void>;
  config: {
    paths: {
      userConfigFile: string;
      globalSkillsDir: string;
      projectSkillsDirName: string;
    };
  };
  capabilities: { workingDir: string };
}

export interface SkillEntry {
  name: string;
  version: string;
  description: string;
  source: SkillSource;
  disabled: boolean;
  dangerous: boolean;
  requiresTools: string[];
  requiresScripts: string[];
  rootDir: string;
}

export function listSkills(deps: SkillServiceDeps): {
  skills: SkillEntry[];
  errors: ReadonlyArray<{ path: string; error: string }>;
} {
  const skills = deps.skillRegistry.listAll().map(({ record, disabled }) => ({
    name: record.manifest.name,
    version: record.manifest.version,
    description: record.manifest.description,
    source: record.source,
    disabled,
    dangerous: record.manifest.dangerous,
    requiresTools: record.manifest.requiresTools,
    requiresScripts: record.manifest.requiresScripts,
    rootDir: record.rootDir,
  }));
  return { skills, errors: deps.skillRegistry.errors() };
}

/**
 * Pure computation of the next `skills.disabled` array. Returns `null`
 * when no change is needed (already in the target state) so the caller
 * can skip the disk write. Extracted for unit-testing without a config
 * file on disk.
 */
export function computeNextDisabled(
  current: readonly string[],
  name: string,
  disabled: boolean,
): string[] | null {
  const set = new Set(current);
  const wasDisabled = set.has(name);
  if (disabled && wasDisabled) return null;
  if (!disabled && !wasDisabled) return null;
  if (disabled) set.add(name);
  else set.delete(name);
  return Array.from(set).sort();
}

async function setSkillDisabled(
  deps: SkillServiceDeps,
  name: string,
  disabled: boolean,
): Promise<{ changed: boolean; disabled: string[] }> {
  const path = deps.config.paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const next = computeNextDisabled(file.skills.disabled, name, disabled);
  if (next === null) {
    return { changed: false, disabled: [...file.skills.disabled] };
  }
  const updated: UserConfigFile = {
    ...file,
    skills: { ...file.skills, disabled: next },
  };
  writeUserConfigFileSync(path, updated);
  resetConfigCache();
  deps.skillRegistry.setDisabledNames(next);
  await deps.refreshSkills();
  return { changed: true, disabled: next };
}

export function enableSkill(
  deps: SkillServiceDeps,
  name: string,
): Promise<{ changed: boolean; disabled: string[] }> {
  assertName(name);
  return setSkillDisabled(deps, name, false);
}

export function disableSkill(
  deps: SkillServiceDeps,
  name: string,
): Promise<{ changed: boolean; disabled: string[] }> {
  assertName(name);
  return setSkillDisabled(deps, name, true);
}

export interface InstallSkillInput {
  sourcePath: string;
  source?: "global" | "project";
  force?: boolean;
}

export async function installSkillFromPath(
  deps: SkillServiceDeps,
  input: InstallSkillInput,
): Promise<{ manifest: SkillManifest; installedAt: string }> {
  if (typeof input.sourcePath !== "string" || input.sourcePath.length === 0) {
    throw new RuntimeApiError(
      "sourcePath is required",
      "invalid_request",
      "sourcePath",
    );
  }
  const targetRoot = resolveSkillsTarget(deps, input.source ?? "global");
  try {
    const result = await installSkill({
      sourceDir: input.sourcePath,
      targetRoot,
      ...(input.force ? { force: true } : {}),
    });
    await deps.refreshSkills();
    return { manifest: result.manifest, installedAt: result.installedAt };
  } catch (err) {
    if (err instanceof SkillInstallError) {
      throw new RuntimeApiError(
        err.message,
        err.code === "already_installed" ? "conflict" : "invalid_request",
      );
    }
    throw err;
  }
}

export async function uninstallSkillByName(
  deps: SkillServiceDeps,
  input: { name: string; source?: "global" | "project" },
): Promise<{ removed: boolean; path: string }> {
  assertName(input.name);
  const targetRoot = resolveSkillsTarget(deps, input.source ?? "global");
  const outcome = await uninstallSkill(targetRoot, input.name);
  pruneDisabledEntry(deps, input.name);
  await deps.refreshSkills();
  return outcome;
}

function pruneDisabledEntry(deps: SkillServiceDeps, name: string): void {
  const path = deps.config.paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  if (!file.skills.disabled.includes(name)) return;
  const nextDisabled = file.skills.disabled.filter((n) => n !== name);
  const updated: UserConfigFile = {
    ...file,
    skills: { ...file.skills, disabled: nextDisabled },
  };
  writeUserConfigFileSync(path, updated);
  resetConfigCache();
  deps.skillRegistry.setDisabledNames(nextDisabled);
}

function resolveSkillsTarget(
  deps: SkillServiceDeps,
  source: "global" | "project",
): string {
  if (source === "project") {
    return join(
      deps.capabilities.workingDir,
      deps.config.paths.projectSkillsDirName,
    );
  }
  return deps.config.paths.globalSkillsDir;
}

function assertName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new RuntimeApiError("name is required", "invalid_request", "name");
  }
}
