import type { AtomicAgentConfig } from "../config/index.js";
import type { SessionState } from "../session/session-state.js";
import type { SessionWorkspace } from "../session/workspace-context.js";
import { loadWorkspaceSkills } from "../skills/workspace-skills.js";
import { loadProjectInstructions } from "./project-instructions.js";

export function createWorkspaceLoader(config: AtomicAgentConfig) {
  return (session: Pick<SessionState, "workingDir">, cloud: boolean, signal?: AbortSignal): SessionWorkspace => {
    signal?.throwIfAborted();
    const skills = loadWorkspaceSkills(session.workingDir, { globalDir: config.paths.globalSkillsDir,
      projectDirName: config.paths.projectSkillsDirName, configFile: config.paths.userConfigFile, defaults: config.skills }, cloud);
    const instructions = cloud ? loadProjectInstructions(session.workingDir, signal) : { instructions: [], diagnostics: [] };
    return { workingDir: skills.workingDir, cloud, skills, instructions: instructions.instructions,
      diagnostics: [...instructions.diagnostics, ...skills.diagnostics] };
  };
}
