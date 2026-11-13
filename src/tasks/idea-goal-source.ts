import { readGoalState } from "../agent/goal/goal-state.js";
import type { SessionState } from "../session/index.js";

import type { GoalIdeaInput } from "./idea-rules.js";

/**
 * The goal source of proactive suggestions (ATO-458): the goals stored
 * with chats (`session.metadata.goal`), reduced to what the rule reads.
 * Sessions without a goal, or with one that no longer parses, give
 * nothing.
 */
export function goalIdeaInputs(
  sessions: readonly Pick<SessionState, "id" | "metadata">[],
): GoalIdeaInput[] {
  const out: GoalIdeaInput[] = [];
  for (const s of sessions) {
    const goal = readGoalState(s.metadata);
    if (goal === null) continue;
    out.push({
      sessionId: s.id,
      status: goal.status,
      statusReason: goal.statusReason ?? null,
      openCriteria: goal.criteria.filter((c) => c.mark !== "met").map((c) => c.text),
      goalCreatedAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    });
  }
  return out;
}
