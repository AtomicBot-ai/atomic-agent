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
  /** Rules scoped by `paths:`/`globs:`; each enters the prompt tail only after a tool touched a matching file (ATO-2247). */
  pathRules?: readonly PathRule[];
}

/** A project rule that applies to matching files only. */
export interface PathRule {
  /** Workspace-relative path of the rule file, with forward slashes. */
  path: string;
  /** Glob patterns, relative to the workspace; a pattern without `/` matches a file name in any folder. */
  patterns: readonly string[];
  /** Rule text without its frontmatter. */
  body: string;
}

export interface WorkspacePrepareOptions {
  /** The active model's context window in tokens, when known; caps project instructions to a share of it. */
  contextWindow?: number | null;
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
