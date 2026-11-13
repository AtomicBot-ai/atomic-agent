import { goalSpecOf, isInterruptedGoal, readGoalState, type GoalSpec, type GoalState } from "../agent/goal/index.js";
import type { SessionState } from "../session/index.js";

/**
 * Goal rounds on `POST /v1/chat/completions` (ATO-1040). The TUI's rule
 * (src/tui/goal/goal-commands.ts `activeGoalSpec`): a chat whose stored
 * goal is active runs every message as goal rounds; a paused, blocked or
 * finished goal leaves ordinary turns alone. Only an extensions client
 * (the desktop) gets it: it can show the progress and pause the goal; a
 * plain OpenAI client keeps getting one ordinary turn per request. An
 * active goal a restart cut off (ATO-1038) does not run either: only an
 * explicit resume (`POST /api/sessions/{id}/goal {action: "resume"}`)
 * continues it, the same rule as the TUI's `/goal resume`.
 */
export function chatGoalSpec(session: SessionState, extensionsEnabled: boolean): GoalSpec | undefined {
  if (!extensionsEnabled) return undefined;
  const goal = readGoalState(session.metadata);
  return goal?.status === "active" && !isInterruptedGoal(goal) ? goalSpecOf(goal) : undefined;
}

/**
 * `event: goal_progress`, after every change of the running goal: its
 * status, per-criterion marks and reasons, rounds used of the limit.
 * The same `GoalState` `GET /api/sessions/{id}/goal` answers.
 */
export function goalProgressFrame(sessionId: string, goal: GoalState): {
  object: "atomic.goal_progress";
  session_id: string;
  goal: GoalState;
} {
  return { object: "atomic.goal_progress", session_id: sessionId, goal };
}
