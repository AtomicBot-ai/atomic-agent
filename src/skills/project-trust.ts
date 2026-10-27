import { readUserConfigFileSync } from "../config/config-file.js";
import { canonicalTrustWorkspace } from "../config/skill-policy-commands.js";
import type { ProjectTrustRecord } from "../config/skills-config.js";

/**
 * Soft trust for what a project folder ships (ATO-298): project skills and
 * project instruction files load only after the operator said yes for that
 * folder. Global skills are not covered; they are always trusted.
 */
export type ProjectItemTrust = "trusted" | "declined" | "pending";

export const UNTRUSTED_SKILL_REASON = "not trusted in this folder yet";
export const DECLINED_SKILL_REASON = "declined in this folder";

/** Command an operator runs to trust a folder from a terminal. */
export function projectTrustHint(workingDir: string): string {
  const arg = /^[\w@%+=:,./\\-]+$/.test(workingDir) ? workingDir : `"${workingDir}"`;
  return `atomic-agent skill project on --workspace ${arg}`;
}

/** Trust key for a folder; a folder that cannot be resolved has no record. */
export function trustKey(workingDir: string): string | null {
  try { return canonicalTrustWorkspace(workingDir); } catch { return null; }
}

export function findProjectTrust(records: readonly ProjectTrustRecord[] | undefined, workingDir: string): ProjectTrustRecord | undefined {
  const key = trustKey(workingDir);
  return key === null ? undefined : records?.find(r => r.workingDir === key);
}

/**
 * Live trust record for a folder. The config file is reread so an answer
 * given in another process (CLI, desktop, a second TUI) applies without a
 * restart. A missing file means no answers yet; an unreadable one falls
 * back to the startup snapshot rather than to "trust everything".
 */
export function readProjectTrust(configFile: string, startup: readonly ProjectTrustRecord[] | undefined, workingDir: string): ProjectTrustRecord | undefined {
  let records = startup;
  try {
    const file = readUserConfigFileSync(configFile);
    records = file ? file.skills.projectTrust : [];
  } catch { /* Keep the startup snapshot. */ }
  return findProjectTrust(records, workingDir);
}

export function skillTrust(record: ProjectTrustRecord | undefined, name: string): ProjectItemTrust {
  if (record?.trustedSkills.includes(name)) return "trusted";
  return record?.declinedSkills.includes(name) ? "declined" : "pending";
}

export function instructionTrust(record: ProjectTrustRecord | undefined, path: string): ProjectItemTrust {
  if (record?.trustedInstructions.includes(path)) return "trusted";
  return record?.declinedInstructions.includes(path) ? "declined" : "pending";
}

export function untrustedSkillReason(trust: ProjectItemTrust): string | null {
  return trust === "trusted" ? null : trust === "declined" ? DECLINED_SKILL_REASON : UNTRUSTED_SKILL_REASON;
}

/**
 * Factory for the local `SkillRegistry` gate: evaluated once per refresh,
 * so one scan reads the config once.
 */
export function createProjectSkillTrustGate(configFile: string, startup: readonly ProjectTrustRecord[] | undefined, workingDir: string): () => (name: string) => ProjectItemTrust {
  return () => {
    const record = readProjectTrust(configFile, startup, workingDir);
    return (name) => skillTrust(record, name);
  };
}
