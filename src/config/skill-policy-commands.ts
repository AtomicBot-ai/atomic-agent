import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig, resetConfigCache } from "./config-cache.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "./config-file.js";
import { isRelativeInstructionPath, parseSkillNameArray, type ProjectTrustRecord } from "./skills-config.js";

/** Runtime/CLI boundary; schema parsing itself never accesses the filesystem. */
export function canonicalSkillWorkspace(path: string): string {
  return realpathSync(resolve(path));
}

/**
 * Key of a folder's trust record. The native realpath also settles letter
 * case on case-insensitive volumes (macOS, Windows), so `~/Repo` and
 * `~/repo` share one answer instead of being two folders to ask about.
 * Symlinks and `..` resolve to the real folder either way.
 */
export function canonicalTrustWorkspace(path: string): string {
  try { return realpathSync.native(resolve(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    return realpathSync(resolve(path));
  }
}

export interface ProjectTrustItems {
  skills: readonly string[];
  instructions: readonly string[];
}

/**
 * Record the operator's answer for the given items of one folder. Each
 * item moves to the trusted or declined list; items not named keep their
 * earlier answer, and items in neither list stay pending.
 */
export function recordProjectTrust(workspace: string, decision: "trusted" | "declined", items: ProjectTrustItems): ProjectTrustRecord {
  parseSkillNameArray([...items.skills], "skill name");
  for (const path of items.instructions) if (!isRelativeInstructionPath(path)) throw new Error(`not a workspace-relative instruction path: ${path}`);
  const workingDir = canonicalTrustWorkspace(workspace);
  const path = getConfig().paths.userConfigFile;
  const file = structuredClone(ensureUserConfigFileSync(path));
  let record = file.skills.projectTrust.find(r => r.workingDir === workingDir);
  if (!record) {
    record = { workingDir, trustedSkills: [], declinedSkills: [], trustedInstructions: [], declinedInstructions: [] };
    file.skills.projectTrust.push(record);
  }
  const move = (add: string[], remove: string[], names: readonly string[]): [string[], string[]] => {
    const added = new Set([...add, ...names]);
    return [[...added].sort(), remove.filter(n => !names.includes(n))];
  };
  if (decision === "trusted") {
    [record.trustedSkills, record.declinedSkills] = move(record.trustedSkills, record.declinedSkills, items.skills);
    [record.trustedInstructions, record.declinedInstructions] = move(record.trustedInstructions, record.declinedInstructions, items.instructions);
  } else {
    [record.declinedSkills, record.trustedSkills] = move(record.declinedSkills, record.trustedSkills, items.skills);
    [record.declinedInstructions, record.trustedInstructions] = move(record.declinedInstructions, record.trustedInstructions, items.instructions);
  }
  writeUserConfigFileSync(path, file);
  resetConfigCache();
  return structuredClone(record);
}

export function setSkillDisabled(name: string, disabled: boolean, workspace?: string): void {
  parseSkillNameArray([name], "skill name");
  updatePolicy(workspace, policy => {
    const names = new Set(policy.disabled);
    if (disabled) names.add(name); else names.delete(name);
    policy.disabled = [...names].sort();
  });
}

export function setProjectSkillsEnabled(workspace: string, enabled: boolean): void {
  updatePolicy(workspace, policy => { policy.projectSkillsEnabled = enabled; });
}

function updatePolicy(workspace: string | undefined, update: (policy: { disabled: string[]; projectSkillsEnabled?: boolean }) => void): void {
  const path = getConfig().paths.userConfigFile;
  const file = structuredClone(ensureUserConfigFileSync(path));
  if (workspace === undefined) update(file.skills);
  else {
    const workingDir = canonicalSkillWorkspace(workspace);
    let policy = file.skills.cloudWorkspaces.find(p => p.workingDir === workingDir);
    if (!policy) {
      policy = { workingDir, projectSkillsEnabled: true, disabled: [] };
      file.skills.cloudWorkspaces.push(policy);
    }
    update(policy);
  }
  writeUserConfigFileSync(path, file);
  resetConfigCache();
}
