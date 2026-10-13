import type { AtomicAgentConfig } from "../config/index.js";
import type { SessionState } from "../session/session-state.js";
import type { SessionWorkspace, WorkspacePrepareOptions } from "../session/workspace-context.js";
import { loadWorkspaceSkills } from "../skills/workspace-skills.js";
import { createProjectInstructionsCache } from "./project-instructions.js";

/** Workspace preparation never fails a step except on cancellation; loaders degrade to diagnostics. */
export function createWorkspaceLoader(config: AtomicAgentConfig) {
  // Steps re-prepare the workspace; instruction discovery is reused until a watched file changes.
  const loadProjectInstructions = createProjectInstructionsCache();
  return (session: Pick<SessionState, "workingDir">, cloud: boolean, signal?: AbortSignal, options: WorkspacePrepareOptions = {}): SessionWorkspace => {
    signal?.throwIfAborted();
    const skills = loadWorkspaceSkills(session.workingDir, { globalDir: config.paths.globalSkillsDir,
      projectDirName: config.paths.projectSkillsDirName, configFile: config.paths.userConfigFile, defaults: config.skills }, cloud);
    const instructions = cloud ? loadProjectInstructions(session.workingDir, signal, { contextWindow: options.contextWindow ?? null }) : { instructions: [], diagnostics: [] };
    return { workingDir: skills.workingDir, cloud, skills, instructions: instructions.instructions,
      diagnostics: [...instructions.diagnostics, ...skills.diagnostics] };
  };
}
