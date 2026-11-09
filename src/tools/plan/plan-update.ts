import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  normalizePlanItems,
  PLAN_MAX_ITEMS,
  renderPlanForModel,
  type PlanSnapshot,
} from "../../agent/plan/plan-snapshot.js";
import type { ToolDefinition } from "../tool-registry.js";

/** Key of the snapshot in the result's `details`, read by `applyStateEffects`. */
export const PLAN_SNAPSHOT_DETAIL = "planSnapshot";

/**
 * `plan.update` (ATO-486): the model's live checklist. It sends the
 * WHOLE plan every call, each step with `pending`, `in_progress` or
 * `done`; the newest call wins. The tool is pure: it validates the list
 * and hands the snapshot back in `details.planSnapshot`, which the step
 * commit folds into `SessionState.plan` and announces as `plan_updated`
 * (see `src/agent/plan/plan-snapshot.ts`).
 *
 * Read-only and never asks: it changes nothing outside the session's own
 * record, so it runs in plan mode too, where a model drafting its plan
 * can already show it as a checklist.
 */
export const planUpdateTool: ToolDefinition = {
  name: "plan.update",
  description:
    "Replace the live plan (checklist shown to the user) with the full list of steps and their statuses.",
  readonly: true,
  async run(rawArgs) {
    const items = normalizePlanItems(rawArgs.items);
    const snapshot: PlanSnapshot = { items, updatedAt: Date.now() };
    return compressToolResult(
      {
        tool: "plan.update",
        status: "ok",
        output: renderPlanForModel(snapshot),
        details: { [PLAN_SNAPSHOT_DETAIL]: snapshot },
      },
      // The whole list fits: the default keeps only the last 12 lines.
      { maxTailLines: PLAN_MAX_ITEMS + 2, maxSummaryLength: 6_000 },
    );
  },
};
