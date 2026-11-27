import type { TaskRecord } from "./task-types.js";

/**
 * What running a card as its assignee changes (ATO-2498): the agent
 * profile the card is assigned to (`agent-profiles/`) gives the run its
 * instructions, its tool list and, when it names one that is set up
 * here, its model. The same three things a profile gives a Fusion or
 * `subagent.run` task, and what Claude Code does with an agent file a
 * task is handed to. Resolved by the runtime, which reads the profiles.
 */
export interface AssigneeRun {
  /** The profile's name, as the card names it. */
  profile: string;
  /** The profile's instructions; empty when it has none. */
  instructions: string;
  /**
   * The profile's tool list, when it narrows the tools. The resolver
   * keeps the board card tools in it, so an assignee can still report
   * on its own card.
   */
  toolFilter?: (name: string) => boolean;
  /** The provider the profile's model resolves to, when it is set up here. */
  providerId?: string;
  /** What did not apply (an unknown tool, a model not set up), for the card. */
  notes: string[];
}

/**
 * Resolve a card's assignee for one run: the profile, or `null` when no
 * profile of that name exists for the task's folder. Never throws; a
 * profile that cannot be read is treated as missing.
 */
export type AssigneeResolver = (
  profile: string,
  context: { task: TaskRecord; workingDir: string },
) => AssigneeRun | null;

/**
 * The message the assignee's run is given: the profile's instructions,
 * then the task as it was asked. The instructions go in the turn's own
 * message, as Fusion quotes a profile into a worker's brief
 * (`worker-prompt.ts`); the task's request stays its own words.
 */
export function assigneeMessage(run: AssigneeRun, message: string): string {
  const instructions = run.instructions.trim();
  if (instructions.length === 0) {
    return `You are working on this task as the "${run.profile}" agent profile.\n\n${message}`;
  }
  return [
    `You are working on this task as the "${run.profile}" agent profile. Its instructions:`,
    "",
    instructions,
    "",
    "The task:",
    message,
  ].join("\n");
}

/** The card comment for an assignee that could not be applied as written. */
export function assigneeNotice(profile: string, run: AssigneeRun | null): string | null {
  if (run === null) {
    return `Agent profile "${profile}" was not found, so this run used the main agent.`;
  }
  if (run.notes.length === 0) return null;
  return `Ran as "${profile}". ${run.notes.join(" ")}`;
}
