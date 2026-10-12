import type { WorkspaceSkills } from "../skills/workspace-skills.js";
import { workspaceSkillBody } from "../skills/workspace-skills.js";
import type { SessionState, LoadedSkillBody } from "./session-state.js";

export interface CloudLoadedSkill extends LoadedSkillBody {
  workspace: string;
  sourcePath: string;
  fingerprint: string;
}
export interface SessionWorkspace {
  workingDir: string;
  cloud: boolean;
  skills: WorkspaceSkills;
  instructions: readonly { path: string; scope: string; body: string; priority: number }[];
  diagnostics: readonly string[];
}

/** Reconcile only previously requested bodies. New catalog entries remain lazy. */
export function reconcileCloudSkills(session: SessionState, workspace: SessionWorkspace): SessionState {
  const previous = session.cloudLoadedSkills;
  const loaded = previous ?? session.loadedSkills;
  const next: CloudLoadedSkill[] = [];
  for (const old of loaded) {
    const entry = workspace.skills.entries.find(e => e.record.manifest.name === old.name && !e.disabledReasons.length);
    if (!entry) continue;
    if ("sourcePath" in old && (old.sourcePath !== entry.record.manifestPath || !("workspace" in old) || old.workspace !== workspace.workingDir)) continue;
    next.push({ name: old.name, version: entry.record.manifest.version, body: workspaceSkillBody(entry), loadedAt: old.loadedAt,
      workspace: workspace.workingDir, sourcePath: entry.record.manifestPath, fingerprint: entry.fingerprint });
  }
  return JSON.stringify(previous) === JSON.stringify(next) ? session : { ...session, cloudLoadedSkills: next };
}
