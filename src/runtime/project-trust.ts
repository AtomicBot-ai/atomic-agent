import { createHash } from "node:crypto";
import type { AtomicAgentConfig } from "../config/index.js";
import { recordProjectTrust } from "../config/skill-policy-commands.js";
import type { ProjectTrustRecord } from "../config/skills-config.js";
import { commandTrust, instructionTrust, projectTrustHint, skillTrust, trustKey, type ProjectItemTrust } from "../skills/project-trust.js";
import { listProjectCommandTrustKeys } from "../plugins/user-commands.js";
import { projectCommandKeyPath } from "../plugins/project-command-trust.js";
import { loadWorkspaceSkills } from "../skills/workspace-skills.js";
import { loadProjectInstructions } from "./project-instructions.js";
import { listProjectAgentProfilePaths } from "../agent-profiles/profile-loader.js";

/**
 * The one-time question about a folder's project skills, instruction
 * files and subagent profile files (ATO-298 soft trust, ATO-566), shared by the TUI, the HTTP routes and the
 * CLI. Project slash command files (ATO-2531) are asked about too, each
 * for its exact text. Nothing here decides on its own: without an answer
 * every item stays unloaded.
 */
export interface ProjectTrustItemsView {
  skills: string[];
  instructions: string[];
  /** Project slash command files, workspace-relative paths (the hash stays internal). */
  commands: string[];
}
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

interface Inventory {
  workingDir: string; skills: string[]; instructions: string[];
  /** Command trust keys (`<path>#<hash>`). */
  commands: string[];
  record: ProjectTrustRecord | undefined;
}

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
  // Subagent profile files (ATO-566) are asked about like instruction files, by path.
  const instructions = [...loadProjectInstructions(scan.workingDir, undefined, { allow: () => false }).found,
    ...listProjectAgentProfilePaths(scan.workingDir, config.paths.stateDir)];
  const commands = listProjectCommandTrustKeys(scan.workingDir, config.paths.stateDir);
  return { workingDir: trustKey(scan.workingDir) ?? scan.workingDir, skills, instructions, commands, record: scan.projectTrust };
}

function split<T extends string>(items: readonly T[], trustOf: (item: T) => ProjectItemTrust): Record<ProjectItemTrust, T[]> {
  const out: Record<ProjectItemTrust, T[]> = { trusted: [], declined: [], pending: [] };
  for (const item of items) out[trustOf(item)].push(item);
  return out;
}

/** The status, plus the pending command keys an answer records (the view shows paths only). */
function evaluate(found: Inventory): { status: ProjectTrustStatus; pendingCommandKeys: string[] } {
  const skills = split(found.skills, name => skillTrust(found.record, name));
  const instructions = split(found.instructions, path => instructionTrust(found.record, path));
  const commands = split(found.commands, key => commandTrust(found.record, key));
  const paths = (keys: readonly string[]) => keys.map(projectCommandKeyPath);
  const pending = { skills: skills.pending, instructions: instructions.pending, commands: paths(commands.pending) };
  const any = pending.skills.length + pending.instructions.length + pending.commands.length > 0;
  const hasEarlierAnswer = !!found.record && [found.record.trustedSkills, found.record.declinedSkills,
    found.record.trustedInstructions, found.record.declinedInstructions,
    found.record.trustedCommands ?? [], found.record.declinedCommands ?? []].some(list => list.length > 0);
  // The id covers the command hashes: a file edited after the question was shown changes it.
  const asked = [found.workingDir, pending.skills, pending.instructions, commands.pending];
  const status: ProjectTrustStatus = {
    workingDir: found.workingDir,
    pending,
    trusted: { skills: skills.trusted, instructions: instructions.trusted, commands: paths(commands.trusted) },
    declined: { skills: skills.declined, instructions: instructions.declined, commands: paths(commands.declined) },
    questionId: any ? createHash("sha256").update(JSON.stringify(asked)).digest("hex").slice(0, 16) : null,
    question: any ? describeProjectTrustQuestion(pending, hasEarlierAnswer) : null,
    hasEarlierAnswer,
    hint: projectTrustHint(found.workingDir),
  };
  return { status, pendingCommandKeys: commands.pending };
}

function status(found: Inventory): ProjectTrustStatus {
  return evaluate(found).status;
}

/** "This folder has 3 project skills and AGENTS.md. Trust them?" */
export function describeProjectTrustQuestion(
  pending: Pick<ProjectTrustItemsView, "skills" | "instructions"> & { commands?: readonly string[] },
  isNew = false,
): string {
  const adjective = isNew ? "new " : "";
  const parts: string[] = [];
  const s = pending.skills.length;
  if (s) parts.push(`${s} ${adjective}project skill${s === 1 ? "" : "s"}`);
  const n = pending.instructions.length;
  if (n && n <= 2) parts.push(`${isNew ? "new " : ""}${pending.instructions.join(" and ")}`);
  else if (n) parts.push(`${n} ${adjective}instruction files`);
  const c = pending.commands?.length ?? 0;
  if (c) parts.push(`${c} ${adjective}project command${c === 1 ? "" : "s"}`);
  const total = s + n + c;
  const list = parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `This folder has ${list}. Trust ${total === 1 ? "it" : "them"}?`;
}

export function inspectProjectTrust(config: AtomicAgentConfig, workingDir: string): ProjectTrustStatus {
  return status(inventory(config, workingDir));
}

/**
 * Answer the pending question. Only the items it asked about are recorded;
 * `questionId` must match the current pending set or nothing is written.
 */
export function answerProjectTrust(config: AtomicAgentConfig, workingDir: string, answer: ProjectTrustAnswer, questionId: string): ProjectTrustStatus {
  const { status: current, pendingCommandKeys } = evaluate(inventory(config, workingDir));
  if (current.questionId === null) return current;
  if (current.questionId !== questionId) throw new ProjectTrustConflictError(current);
  recordProjectTrust(current.workingDir, answer === "trust" ? "trusted" : "declined",
    { skills: current.pending.skills, instructions: current.pending.instructions, commands: pendingCommandKeys });
  return inspectProjectTrust(config, workingDir);
}

/**
 * `skill project on|off --workspace`: an explicit operator decision about
 * everything the folder ships now, including items answered earlier.
 */
export function setProjectTrust(config: AtomicAgentConfig, workingDir: string, trusted: boolean): ProjectTrustStatus {
  const found = inventory(config, workingDir);
  recordProjectTrust(found.workingDir, trusted ? "trusted" : "declined",
    { skills: found.skills, instructions: found.instructions, commands: found.commands });
  return inspectProjectTrust(config, workingDir);
}
