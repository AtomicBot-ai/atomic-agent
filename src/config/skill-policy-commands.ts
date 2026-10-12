import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig, resetConfigCache } from "./config-cache.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "./config-file.js";
import { parseSkillNameArray } from "./skills-config.js";

/** Runtime/CLI boundary; schema parsing itself never accesses the filesystem. */
export function canonicalSkillWorkspace(path: string): string {
  return realpathSync(resolve(path));
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
