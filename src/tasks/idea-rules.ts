import type { TaskRecord } from "./task-types.js";
import {
  IDEA_EXCERPT_MAX_LENGTH,
  IDEA_TITLE_MAX_LENGTH,
  IDEAS_PER_KIND_MAX,
  type IdeaCandidate,
} from "./idea-types.js";

/**
 * The rules behind proactive suggestions (ATO-458). Pure functions over
 * records the agent already keeps locally: the task queue and the goals
 * stored with chats. No model call, no network.
 *
 * Mail is not a source yet: the agent's inbox is read live over JMAP
 * and nothing of it is kept on disk, so a rule over it would have to
 * fetch. See the open question in the ATO-458 PR.
 */

/** A chat's stored goal, reduced to what the rule reads (see `idea-goal-source.ts`). */
export interface GoalIdeaInput {
  sessionId: string;
  status: "active" | "paused" | "blocked" | "complete" | "budget_limited";
  statusReason: string | null;
  /** Checklist items not marked met, in order. */
  openCriteria: string[];
  /** Identifies this goal on the session: a new goal there is a new source. */
  goalCreatedAt: number;
  updatedAt: number;
}

export interface IdeaRuleInput {
  tasks: readonly TaskRecord[];
  goals: readonly GoalIdeaInput[];
  now: number;
}

/** How far back a failed task still counts as worth retrying. */
export const RETRY_TASK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** How far back a stopped goal still counts as worth finishing. */
export const RESUME_GOAL_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export function buildIdeaCandidates(input: IdeaRuleInput): IdeaCandidate[] {
  return [...retryTaskIdeas(input.tasks, input.now), ...resumeGoalIdeas(input.goals, input.now)];
}

/**
 * A task that ended `failed` or `blocked` recently, and that nothing ran
 * again: no later task carries the same message, whatever became of it.
 * A cancelled task is a person's decision and is never suggested.
 */
export function retryTaskIdeas(tasks: readonly TaskRecord[], now: number): IdeaCandidate[] {
  const latestByMessage = new Map<string, number>();
  for (const t of tasks) {
    const key = messageKey(t.userMessage);
    latestByMessage.set(key, Math.max(latestByMessage.get(key) ?? 0, t.createdAt));
  }
  const out: Array<{ at: number; idea: IdeaCandidate }> = [];
  for (const t of tasks) {
    if (t.status !== "failed" && t.status !== "blocked") continue;
    const endedAt = t.completedAt ?? t.updatedAt;
    if (now - endedAt > RETRY_TASK_LOOKBACK_MS) continue;
    if ((latestByMessage.get(messageKey(t.userMessage)) ?? 0) > t.createdAt) continue;
    const what = t.status === "failed" ? "failed" : "was blocked";
    out.push({
      at: endedAt,
      idea: {
        kind: "retry_task",
        sourceKey: `task:${t.id}`,
        title: clip(`Retry: ${oneLine(t.userMessage)}`, IDEA_TITLE_MAX_LENGTH),
        reason: `This task ${what} and has not been run again.`,
        evidence: {
          source: "task",
          ref: t.id,
          excerpt: clip(oneLine(t.lastError ?? "No error was recorded."), IDEA_EXCERPT_MAX_LENGTH),
          at: endedAt,
        },
        prompt: t.userMessage,
        // A fresh chat: a blocked task is often blocked by its session.
        sessionId: null,
      },
    });
  }
  return newestFirst(out);
}

/**
 * A goal that stopped short (paused, or out of rounds) recently, with
 * items still open. A blocked goal waits for the person, and an active
 * or complete one needs nothing, so neither is suggested.
 */
export function resumeGoalIdeas(goals: readonly GoalIdeaInput[], now: number): IdeaCandidate[] {
  const out: Array<{ at: number; idea: IdeaCandidate }> = [];
  for (const g of goals) {
    if (g.status !== "paused" && g.status !== "budget_limited") continue;
    if (g.openCriteria.length === 0) continue;
    if (now - g.updatedAt > RESUME_GOAL_LOOKBACK_MS) continue;
    const why =
      g.status === "paused"
        ? "The goal in this chat was paused before its checklist was done."
        : "The goal in this chat ran out of rounds before its checklist was done.";
    const open = g.openCriteria.map((c) => oneLine(c));
    const stopped = g.statusReason ? `${oneLine(g.statusReason)} ` : "";
    out.push({
      at: g.updatedAt,
      idea: {
        kind: "resume_goal",
        sourceKey: `goal:${g.sessionId}:${g.goalCreatedAt}`,
        title: clip(`Finish the goal: ${open[0]}`, IDEA_TITLE_MAX_LENGTH),
        reason: why,
        evidence: {
          source: "goal",
          ref: g.sessionId,
          excerpt: clip(`${stopped}Still open: ${open.join("; ")}`, IDEA_EXCERPT_MAX_LENGTH),
          at: g.updatedAt,
        },
        prompt: [
          "Continue the goal in this chat. These items are still open:",
          ...open.map((c) => `- ${c}`),
          "Work through them and check each one before you reply.",
        ].join("\n"),
        sessionId: g.sessionId,
      },
    });
  }
  return newestFirst(out);
}

function newestFirst(items: Array<{ at: number; idea: IdeaCandidate }>): IdeaCandidate[] {
  return items
    .sort((a, b) => b.at - a.at)
    .slice(0, IDEAS_PER_KIND_MAX)
    .map((i) => i.idea);
}

function messageKey(message: string): string {
  return message.trim().replace(/\s+/g, " ").toLowerCase();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
