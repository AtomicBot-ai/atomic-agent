import type { AtomicAgentConfig } from "../config/index.js";
import type { SessionState } from "../session/session-state.js";
import type { SessionWorkspace, WorkspacePrepareOptions } from "../session/workspace-context.js";
import { instructionTrust, projectTrustHint, skillTrust } from "../skills/project-trust.js";
import { loadWorkspaceSkills } from "../skills/workspace-skills.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import { createProjectInstructionsCache } from "./project-instructions.js";

/** Workspace preparation never fails a step except on cancellation; loaders degrade to diagnostics. */
export function createWorkspaceLoader(config: AtomicAgentConfig, logger?: Pick<StructuredLogger, "warn">) {
  // Steps re-prepare the workspace; instruction discovery is reused until a watched file changes.
  const loadProjectInstructions = createProjectInstructionsCache();
  // One hint per folder and set of withheld items, not one per step.
  const hinted = new Map<string, string>();
  return (session: Pick<SessionState, "workingDir">, cloud: boolean, signal?: AbortSignal, options: WorkspacePrepareOptions = {}): SessionWorkspace => {
    signal?.throwIfAborted();
    const skills = loadWorkspaceSkills(session.workingDir, { globalDir: config.paths.globalSkillsDir,
      projectDirName: config.paths.projectSkillsDirName, configFile: config.paths.userConfigFile, defaults: config.skills }, cloud);
    // Instruction files a folder ships load only once the operator trusted them (ATO-298),
    // judged with the same policy snapshot the skill scan just read.
    const trust = skills.projectTrust;
    const allowed = trust?.trustedInstructions ?? [];
    const instructions = cloud
      ? loadProjectInstructions(session.workingDir, signal, { contextWindow: options.contextWindow ?? null,
        allow: path => instructionTrust(trust, path) === "trusted", allowKey: [...allowed].sort().join("\0") })
      : { instructions: [], diagnostics: [], found: [] };
    if (logger) {
      const withheldSkills = skills.entries.filter(e => e.record.source === "project" && skillTrust(trust, e.record.manifest.name) === "pending").map(e => e.record.manifest.name);
      const withheldFiles = instructions.found.filter(path => instructionTrust(trust, path) === "pending");
      const signature = [...withheldSkills, "\0", ...withheldFiles].join("\n");
      if ((withheldSkills.length || withheldFiles.length) && hinted.get(skills.workingDir) !== signature) {
        hinted.set(skills.workingDir, signature);
        // Operator log only: a hint in the model's context would invite it to trust the folder itself.
        logger.warn("project skills and instructions in this folder are not trusted yet and were not loaded", {
          workingDir: skills.workingDir, skills: withheldSkills.length, instructionFiles: withheldFiles.length, hint: projectTrustHint(skills.workingDir) });
      }
    }
    return { workingDir: skills.workingDir, cloud, skills, instructions: instructions.instructions,
      diagnostics: [...instructions.diagnostics, ...skills.diagnostics] };
  };
}
