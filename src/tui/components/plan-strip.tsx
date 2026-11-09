import { Box, Text } from "ink";
import type { ReactElement } from "react";

import {
  planProgress,
  type PlanItem,
  type PlanSnapshot,
} from "../../agent/plan/plan-snapshot.js";
import { theme } from "../theme/theme.js";
import { previewOf } from "./queued-messages.js";

/** Step rows the strip draws at most; the rest are counted. */
export const PLAN_STRIP_MAX_ROWS = 5;
/** Fallback width when the caller does not know the terminal size. */
const DEFAULT_WIDTH = 60;

export interface PlanStripRow {
  item: PlanItem;
  /** Index of the step in the plan, for a stable React key. */
  index: number;
}

export interface PlanStripLayout {
  rows: PlanStripRow[];
  /** Done steps above the window, folded into one line. */
  doneAbove: number;
  /** Steps below the window, folded into one line. */
  moreBelow: number;
}

/**
 * Which steps fit in `maxRows`: a window that starts one row above the
 * step in progress (the last finished step, for context) and runs down
 * from there. Steps above the window are all done and are counted; the
 * steps below are counted too. A finished plan draws no rows: the header
 * says it is done.
 */
export function planStripLayout(
  plan: PlanSnapshot,
  maxRows: number = PLAN_STRIP_MAX_ROWS,
): PlanStripLayout {
  const items = plan.items;
  const open = items.findIndex((item) => item.status !== "done");
  if (open === -1) return { rows: [], doneAbove: items.length, moreBelow: 0 };
  const active = items.findIndex((item) => item.status === "in_progress");
  const anchor = active === -1 ? open : active;
  const rows = Math.max(1, maxRows);
  let start = Math.max(0, anchor - 1);
  // Do not leave empty rows at the bottom when the list ends early.
  start = Math.max(0, Math.min(start, items.length - rows));
  const end = Math.min(items.length, start + rows);
  const doneAbove = items.slice(0, start).filter((item) => item.status === "done").length;
  return {
    rows: items.slice(start, end).map((item, i) => ({ item, index: start + i })),
    doneAbove,
    moreBelow: items.length - end + (start - doneAbove),
  };
}

const MARK: Readonly<Record<PlanItem["status"], string>> = {
  done: theme.glyphs.check,
  in_progress: theme.glyphs.chevronRight,
  pending: "○",
};

/**
 * The live plan (ATO-486), drawn directly above the composer: a header
 * with `plan 3/7` and the steps around the one in progress, ticks on the
 * finished ones. Renders nothing without a plan, so the composer only
 * moves when the model starts or clears one.
 */
export function PlanStrip({
  plan,
  width,
}: {
  plan: PlanSnapshot | null;
  width?: number;
}): ReactElement | null {
  if (plan === null || plan.items.length === 0) return null;
  const { done, total } = planProgress(plan);
  const layout = planStripLayout(plan);
  const stepWidth = Math.max(16, (width ?? DEFAULT_WIDTH) - 8);
  const finished = done === total;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={theme.colors.muted}>
        {"  "}
        <Text color={finished ? theme.colors.toolOk : theme.colors.accent} bold>
          plan {done}/{total}
        </Text>
        {finished ? ` ${theme.glyphs.check} done` : ""}
        {layout.doneAbove > 0 && !finished
          ? ` ${theme.glyphs.dotSeparator} ${layout.doneAbove} done above`
          : ""}
      </Text>
      {layout.rows.map(({ item, index }) => (
        <Text
          key={`plan-${index}`}
          color={
            item.status === "in_progress"
              ? theme.colors.assistant
              : theme.colors.muted
          }
          bold={item.status === "in_progress"}
        >
          {"    "}
          <Text color={item.status === "done" ? theme.colors.toolOk : undefined}>
            {MARK[item.status]}
          </Text>{" "}
          {previewOf(item.step, stepWidth)}
        </Text>
      ))}
      {layout.moreBelow > 0 ? (
        <Text color={theme.colors.muted}>
          {"    "}
          {theme.glyphs.ellipsis} {layout.moreBelow} more
        </Text>
      ) : null}
    </Box>
  );
}

/** The status-bar tag: `plan 3/7`, or `null` without a plan. */
export function planStatusTag(plan: PlanSnapshot | null): string | null {
  if (plan === null || plan.items.length === 0) return null;
  const { done, total } = planProgress(plan);
  return `plan ${done}/${total}`;
}
