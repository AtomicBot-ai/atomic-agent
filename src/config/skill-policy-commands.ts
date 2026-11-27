import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pluginSkillPart, setPluginPartEnabled } from "../plugins/plugin-install.js";
import { getConfig, resetConfigCache } from "./config-cache.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "./config-file.js";
import { isProjectCommandTrustKey, isRelativeInstructionPath, parseSkillNameArray, type ProjectTrustRecord } from "./skills-config.js";

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
  /** Project command trust keys (`<path>#<hash>`, ATO-2531). */
  commands?: readonly string[];
}

/**
 * Record the operator's answer for the given items of one folder. Each
 * item moves to the trusted or declined list; items not named keep their
 * earlier answer, and items in neither list stay pending.
 */
export function recordProjectTrust(workspace: string, decision: "trusted" | "declined", items: ProjectTrustItems): ProjectTrustRecord {
  parseSkillNameArray([...items.skills], "skill name");
  for (const path of items.instructions) if (!isRelativeInstructionPath(path)) throw new Error(`not a workspace-relative instruction path: ${path}`);
  const commands = items.commands ?? [];
  for (const key of commands) if (!isProjectCommandTrustKey(key)) throw new Error(`not a project command trust key: ${key}`);
  const workingDir = canonicalTrustWorkspace(workspace);
  const path = getConfig().paths.userConfigFile;
  const file = structuredClone(ensureUserConfigFileSync(path));
  let record = file.skills.projectTrust.find(r => r.workingDir === workingDir);
  if (!record) {
    record = { workingDir, trustedSkills: [], declinedSkills: [], trustedInstructions: [], declinedInstructions: [], trustedCommands: [], declinedCommands: [] };
    file.skills.projectTrust.push(record);
  }
  const move = (add: string[], remove: string[], names: readonly string[]): [string[], string[]] => {
    const added = new Set([...add, ...names]);
    return [[...added].sort(), remove.filter(n => !names.includes(n))];
  };
  // A command answered again for new text replaces the answer for its old text.
  const answeredPaths = new Set(commands.map(commandKeyPath));
  const otherText = (key: string) => !answeredPaths.has(commandKeyPath(key)) || commands.includes(key);
  record.trustedCommands = (record.trustedCommands ?? []).filter(otherText);
  record.declinedCommands = (record.declinedCommands ?? []).filter(otherText);
  if (decision === "trusted") {
    [record.trustedSkills, record.declinedSkills] = move(record.trustedSkills, record.declinedSkills, items.skills);
    [record.trustedInstructions, record.declinedInstructions] = move(record.trustedInstructions, record.declinedInstructions, items.instructions);
    [record.trustedCommands, record.declinedCommands] = move(record.trustedCommands, record.declinedCommands, commands);
  } else {
    [record.declinedSkills, record.trustedSkills] = move(record.declinedSkills, record.trustedSkills, items.skills);
    [record.declinedInstructions, record.trustedInstructions] = move(record.declinedInstructions, record.trustedInstructions, items.instructions);
    [record.declinedCommands, record.trustedCommands] = move(record.declinedCommands, record.trustedCommands, commands);
  }
  writeUserConfigFileSync(path, file);
  resetConfigCache();
  return structuredClone(record);
}

/** The path half of a command trust key. */
function commandKeyPath(key: string): string {
  return key.slice(0, key.lastIndexOf("#"));
}

export function setSkillDisabled(name: string, disabled: boolean, workspace?: string): void {
  const pluginSkill = pluginSkillPart(name);
  if (pluginSkill) {
    if (workspace !== undefined) {
      throw new Error(`A plugin skill cannot be switched per folder. Use: atomic-agent plugin ${disabled ? "disable" : "enable"} ${pluginSkill.plugin} --part ${pluginSkill.part}`);
    }
    if (!setPluginPartEnabled(getConfig().paths.stateDir, pluginSkill.plugin, pluginSkill.part, !disabled)) {
      throw new Error(`plugin not installed: ${pluginSkill.plugin}`);
    }
    return;
  }
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
