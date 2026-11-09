import type { CompressedToolResult } from "../compressor/result-compressor.js";
import type { StepToolSet } from "./policies/step-tool-set.js";
import { isRefusedResult } from "./review-stall.js";

/**
 * The loop's half of automatic replanning (ATO-941).
 *
 * `fusion.delegate` reports, in `details.replan.pending`, the tasks that
 * did not close and still have replans left this turn
 * (`src/tools/fusion/replan.ts`). While that list is non-empty the
 * planner's next step admits only `fusion.delegate` — the same per-step
 * tool set the stalled review uses (`step-tool-set.ts`) — so a failed
 * part is re-planned from the facts in the same turn instead of waiting
 * for the person to type "continue".
 *
 * Bounded three ways: each task has `autoReplan` replans (counted by the
 * tool); a delegate result without pending tasks lifts the hold; and a
 * planner that does not delegate for `REPLAN_MAX_HELD_STEPS` steps in a
 * row is let go, told once to report what stands. The turn's step and
 * time ceilings and its $ / time caps still apply on top. Off
 * (`autoReplan: 0`, or not an orchestrator turn): no state, no hold.
 */

const DELEGATE_TOOL = "fusion.delegate";
export const REPLAN_TOOL_NAMES: readonly string[] = [DELEGATE_TOOL];
export const REPLAN_HOLD_REASON =
  "replan required: re-delegate the tasks that did not close";
/** Steps in a row a planner may be held without delegating. */
export const REPLAN_MAX_HELD_STEPS = 2;

export interface ReplanState {
  /** Task ids waiting for a replan, `null` while nothing is. */
  pending: readonly string[] | null;
  /** Consecutive held steps without a fan-out. */
  heldSteps: number;
  /** The hold was given up on this turn; the release notice is owed once. */
  releaseNoticeOwed: boolean;
}

export function createReplanState(): ReplanState {
  return { pending: null, heldSteps: 0, releaseNoticeOwed: false };
}

function pendingOf(result: CompressedToolResult): string[] {
  const replan = result.details.replan as
    | { pending?: Array<{ id?: unknown }> }
    | undefined;
  return (replan?.pending ?? [])
    .map((t) => t.id)
    .filter((id): id is string => typeof id === "string");
}

/** Fold one completed step in. */
export function observeReplanStep(
  state: ReplanState,
  results: readonly CompressedToolResult[],
): ReplanState {
  // A call refused before it ran, or one whose args did not parse, is
  // not a replan: the hold stands for the next step.
  const delegated = results.filter(
    (r) =>
      r.tool === DELEGATE_TOOL &&
      !isRefusedResult(r) &&
      !(r.status === "error" && r.details.field === "tasks"),
  );
  if (delegated.length > 0) {
    const pending = delegated.flatMap(pendingOf);
    return {
      pending: pending.length > 0 ? pending : null,
      heldSteps: 0,
      releaseNoticeOwed: false,
    };
  }
  if (state.pending === null) return state;
  const heldSteps = state.heldSteps + 1;
  if (heldSteps >= REPLAN_MAX_HELD_STEPS) {
    return { pending: null, heldSteps: 0, releaseNoticeOwed: true };
  }
  return { ...state, heldSteps };
}

/** The tool set the next step runs under, `null` when it is not held. */
export function replanToolSet(state: ReplanState): StepToolSet | null {
  return state.pending === null
    ? null
    : { names: REPLAN_TOOL_NAMES, reason: REPLAN_HOLD_REASON };
}

/** The `### notice` for the next step, and the state that remembers it. */
export function takeReplanNotice(state: ReplanState): {
  state: ReplanState;
  notice: string | null;
} {
  if (state.pending !== null) {
    return {
      state,
      notice: `Replan required: ${state.pending.join(", ")} did not close. This step runs only \`fusion.delegate\`: rewrite those briefs from the facts in the last result and send them again with the same ids.`,
    };
  }
  if (state.releaseNoticeOwed) {
    return {
      state: { ...state, releaseNoticeOwed: false },
      notice:
        "The replan was not sent. Reply to the person now with what stands: what closed, what did not, and why.",
    };
  }
  return { state, notice: null };
}
