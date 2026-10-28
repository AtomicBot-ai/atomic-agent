import { createHash } from "node:crypto";
import type { AtomicAgentConfig } from "../config/index.js";
import { recordProjectTrust } from "../config/skill-policy-commands.js";
import type { ProjectTrustRecord } from "../config/skills-config.js";
import { instructionTrust, projectTrustHint, skillTrust, trustKey, type ProjectItemTrust } from "../skills/project-trust.js";
import { loadWorkspaceSkills } from "../skills/workspace-skills.js";
import { loadProjectInstructions } from "./project-instructions.js";

/**
 * The one-time question about a folder's project skills and instruction
 * files (ATO-298 soft trust), shared by the TUI, the HTTP routes and the
 * CLI. Nothing here decides on its own: without an answer every item
 * stays unloaded.
 */
export interface ProjectTrustItemsView { skills: string[]; instructions: string[] }
export interface ProjectTrustStatus {
  workingDir: string;
  /** Items with no answer yet. They are what a question asks about. */
  pending: ProjectTrustItemsView;
  trusted: ProjectTrustItemsView;
  declined: ProjectTrustItemsView;
  /**
   * Identifies exactly the pending set. An answer must echo it, so an item
   * that appeared after the question was shown is never trusted unseen.
   * Null when nothing is pending.
   */
  questionId: string | null;
  /** Ready-to-show question, e.g. "This folder has 3 project skills and AGENTS.md. Trust them?"; null when nothing is pending. */
  question: string | null;
  /** True when some items were answered before, so the pending ones are new. */
  hasEarlierAnswer: boolean;
  /** Terminal command that trusts the folder. */
  hint: string;
}

export type ProjectTrustAnswer = "trust" | "decline";

export class ProjectTrustConflictError extends Error {
  constructor(readonly status: ProjectTrustStatus) {
    super("The folder changed since the question was shown; ask again.");
    this.name = "ProjectTrustConflictError";
  }
}

interface Inventory { workingDir: string; skills: string[]; instructions: string[]; record: ProjectTrustRecord | undefined }

/**
 * What the folder ships right now. Project skills come from every project
 * skill directory (the cloud set, which includes the local Atomic one);
 * a name a global skill shadows is not loaded from the project and is not
 * asked about. Skills count only while project skills are switched on.
 */
function inventory(config: AtomicAgentConfig, workingDir: string): Inventory {
  const scan = loadWorkspaceSkills(workingDir, { globalDir: config.paths.globalSkillsDir, projectDirName: config.paths.projectSkillsDirName,
    configFile: config.paths.userConfigFile, defaults: config.skills }, true);
  const skills = scan.projectSkillsEnabled ? scan.entries.filter(e => e.record.source === "project").map(e => e.record.manifest.name) : [];
  // Discovery only: nothing is allowed, so no instruction body is read for the question.
  const instructions = loadProjectInstructions(scan.workingDir, undefined, { allow: () => false }).found;
  return { workingDir: trustKey(scan.workingDir) ?? scan.workingDir, skills, instructions, record: scan.projectTrust };
}

function split<T extends string>(items: readonly T[], trustOf: (item: T) => ProjectItemTrust): Record<ProjectItemTrust, T[]> {
  const out: Record<ProjectItemTrust, T[]> = { trusted: [], declined: [], pending: [] };
  for (const item of items) out[trustOf(item)].push(item);
  return out;
}

function status(found: Inventory): ProjectTrustStatus {
  const skills = split(found.skills, name => skillTrust(found.record, name));
  const instructions = split(found.instructions, path => instructionTrust(found.record, path));
  const pending = { skills: skills.pending, instructions: instructions.pending };
  const any = pending.skills.length + pending.instructions.length > 0;
  const hasEarlierAnswer = !!found.record && [found.record.trustedSkills, found.record.declinedSkills,
    found.record.trustedInstructions, found.record.declinedInstructions].some(list => list.length > 0);
  return {
    workingDir: found.workingDir,
    pending,
    trusted: { skills: skills.trusted, instructions: instructions.trusted },
    declined: { skills: skills.declined, instructions: instructions.declined },
    questionId: any ? createHash("sha256").update(JSON.stringify([found.workingDir, pending])).digest("hex").slice(0, 16) : null,
    question: any ? describeProjectTrustQuestion(pending, hasEarlierAnswer) : null,
    hasEarlierAnswer,
    hint: projectTrustHint(found.workingDir),
  };
}

/** "This folder has 3 project skills and AGENTS.md. Trust them?" */
export function describeProjectTrustQuestion(pending: ProjectTrustItemsView, isNew = false): string {
  const adjective = isNew ? "new " : "";
  const parts: string[] = [];
  const s = pending.skills.length;
  if (s) parts.push(`${s} ${adjective}project skill${s === 1 ? "" : "s"}`);
  const n = pending.instructions.length;
  if (n && n <= 2) parts.push(`${isNew ? "new " : ""}${pending.instructions.join(" and ")}`);
  else if (n) parts.push(`${n} ${adjective}instruction files`);
  const total = s + n;
  return `This folder has ${parts.join(" and ")}. Trust ${total === 1 ? "it" : "them"}?`;
}

export function inspectProjectTrust(config: AtomicAgentConfig, workingDir: string): ProjectTrustStatus {
  return status(inventory(config, workingDir));
}

/**
 * Answer the pending question. Only the items it asked about are recorded;
 * `questionId` must match the current pending set or nothing is written.
 */
export function answerProjectTrust(config: AtomicAgentConfig, workingDir: string, answer: ProjectTrustAnswer, questionId: string): ProjectTrustStatus {
  const current = status(inventory(config, workingDir));
  if (current.questionId === null) return current;
  if (current.questionId !== questionId) throw new ProjectTrustConflictError(current);
  recordProjectTrust(current.workingDir, answer === "trust" ? "trusted" : "declined", current.pending);
  return inspectProjectTrust(config, workingDir);
}

/**
 * `skill project on|off --workspace`: an explicit operator decision about
 * everything the folder ships now, including items answered earlier.
 */
export function setProjectTrust(config: AtomicAgentConfig, workingDir: string, trusted: boolean): ProjectTrustStatus {
  const found = inventory(config, workingDir);
  recordProjectTrust(found.workingDir, trusted ? "trusted" : "declined", { skills: found.skills, instructions: found.instructions });
  return inspectProjectTrust(config, workingDir);
}
