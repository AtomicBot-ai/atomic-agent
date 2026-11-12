/**
 * Re-plan every N steps (ATO-609), the periodic half of the live plan
 * (ATO-486).
 *
 * On a long task the plan written at the start goes stale: steps turn
 * out to be done, wrong or missing, and the model keeps working from a
 * list that no longer matches what it has found. Like smolagents'
 * `planning_interval`, every `agent.task.replanEveryNSteps` steps the
 * model is asked to check the plan against the facts and send it again
 * through `plan.update`. Unlike smolagents it costs no extra model call:
 * the request rides on the next step's `### notice`, the same channel
 * as the turn-start plan reminder.
 *
 * The counter lives on the session (`SessionState.stepsSinceReplan`),
 * so a task resumed from its per-step checkpoint keeps its cadence. A
 * new user message starts it over (the turn-start reminder covers that
 * boundary), and a step that already sent `plan.update` resets it: the
 * model re-planned by itself, nothing to ask for.
 *
 * `0` (the default) turns the whole thing off: no notice, and the
 * counter is never written.
 */
import type { SessionState } from "../../session/session-state.js";
import { planProgress } from "./plan-snapshot.js";

/** The tool whose successful call counts as a re-plan. */
const PLAN_TOOL = "plan.update";

/** True when the cadence is on: a positive whole number of steps. */
export function replanCadenceEnabled(everyNSteps: number): boolean {
  return Number.isFinite(everyNSteps) && everyNSteps > 0;
}

/**
 * The `### notice` text asking for a re-plan. Names the plan's progress
 * when there is one, asks for a first plan when there is none.
 */
export function replanCadenceNotice(state: SessionState, steps: number): string {
  const plan = state.plan;
  if (plan === undefined || plan.items.length === 0) {
    return [
      `[plan] ${steps} steps into this task and there is no written plan.`,
      "Write one now with plan.update (send the whole list): the steps still ahead, based on what you have found so far. Then carry on.",
    ].join("\n");
  }
  const { done, total } = planProgress(plan);
  return [
    `[plan] ${steps} steps since the plan was last reviewed; it is ${done}/${total} done.`,
    "Check it against what you have learned: mark finished steps done, rewrite or drop steps that no longer fit, add what is missing. Send the whole list with plan.update, then carry on.",
  ].join("\n");
}

/**
 * Read at the top of a step, before its prompt is built. When the
 * counter has reached `everyNSteps` the notice is returned and the
 * counter starts over; otherwise nothing changes.
 */
export function takeReplanCadenceNotice(
  state: SessionState,
  everyNSteps: number,
): { state: SessionState; notice: string | undefined } {
  if (!replanCadenceEnabled(everyNSteps)) return { state, notice: undefined };
  const counted = state.stepsSinceReplan ?? 0;
  if (counted < everyNSteps) return { state, notice: undefined };
  return {
    state: { ...state, stepsSinceReplan: 0 },
    notice: replanCadenceNotice(state, counted),
  };
}

/**
 * Called after a step came back. A step that sent `plan.update`
 * successfully resets the counter; any other completed step adds one.
 */
export function countReplanCadenceStep(
  state: SessionState,
  everyNSteps: number,
  results: readonly { tool: string; status: string }[],
): SessionState {
  if (!replanCadenceEnabled(everyNSteps)) return state;
  const replanned = results.some(
    (result) => result.tool === PLAN_TOOL && result.status === "ok",
  );
  return {
    ...state,
    stepsSinceReplan: replanned ? 0 : (state.stepsSinceReplan ?? 0) + 1,
  };
}

/** A new user message starts the cadence over. */
export function resetReplanCadence(
  state: SessionState,
  everyNSteps: number,
): SessionState {
  if (!replanCadenceEnabled(everyNSteps)) return state;
  if ((state.stepsSinceReplan ?? 0) === 0) return state;
  return { ...state, stepsSinceReplan: 0 };
}
