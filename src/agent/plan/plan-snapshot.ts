/**
 * The live plan (ATO-486): the checklist the model keeps for the work it
 * is doing, drawn above the composer in the TUI and the desktop.
 *
 * The model sends the WHOLE list every time through `plan.update`
 * (`src/tools/plan/plan-update.ts`): a snapshot, never a delta, so a
 * missed or reordered call can never leave the screen showing a list
 * nobody wrote. The latest snapshot lives on the session
 * (`SessionState.plan`), which is persisted with the rest of the session
 * JSON, so a restart or a reopened chat draws the same list. Every
 * change is announced as the step event `plan_updated`.
 *
 * Shared contract for the "readable output" group: other modules (the
 * status snapshot, the desktop plan bar) read `PlanSnapshot` and
 * `planProgress` structurally. Keep the names and shapes.
 */

export type PlanItemStatus = "pending" | "in_progress" | "done";

export interface PlanItem {
  step: string;
  status: PlanItemStatus;
}

export interface PlanSnapshot {
  items: PlanItem[];
  /** Epoch ms of the write that produced this snapshot. */
  updatedAt: number;
}

/** Most steps one plan keeps. A plan longer than this is a log, not a checklist. */
export const PLAN_MAX_ITEMS = 30;
/** Longest step text kept; longer text is cut with an ellipsis. */
export const PLAN_STEP_MAX_CHARS = 160;

/**
 * How far the plan got. `current` is the step in progress, or, when the
 * model marked none, the first one not done yet; absent when every step
 * is done (or there are none).
 */
export function planProgress(s: PlanSnapshot): {
  done: number;
  total: number;
  current?: string;
} {
  const total = s.items.length;
  const done = s.items.filter((item) => item.status === "done").length;
  const current =
    s.items.find((item) => item.status === "in_progress") ??
    s.items.find((item) => item.status !== "done");
  return current === undefined
    ? { done, total }
    : { done, total, current: current.step };
}

/** True when the plan has at least one step that is not done. */
export function planHasOpenItems(s: PlanSnapshot | null | undefined): boolean {
  return s !== null && s !== undefined && s.items.some((item) => item.status !== "done");
}

/**
 * Status words small models use for the same three states. Matched after
 * lower-casing and turning spaces and dashes into underscores.
 */
const STATUS_ALIASES: Readonly<Record<string, PlanItemStatus>> = {
  pending: "pending",
  todo: "pending",
  to_do: "pending",
  not_started: "pending",
  open: "pending",
  in_progress: "in_progress",
  inprogress: "in_progress",
  active: "in_progress",
  doing: "in_progress",
  running: "in_progress",
  started: "in_progress",
  current: "in_progress",
  done: "done",
  completed: "done",
  complete: "done",
  finished: "done",
  ok: "done",
};

/** Reads a status word; `null` when it is not one of the three states. */
export function parsePlanItemStatus(raw: unknown): PlanItemStatus | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return STATUS_ALIASES[key] ?? null;
}

/** One line, trimmed, capped at {@link PLAN_STEP_MAX_CHARS}. */
export function cleanPlanStep(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= PLAN_STEP_MAX_CHARS) return flat;
  return `${flat.slice(0, PLAN_STEP_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Validate the `items` a `plan.update` call sent. Throws a message the
 * model can act on; the tool turns it into an ordinary tool error.
 *
 * Accepted: an array of `{ step, status }`. A bare string item is read as
 * a pending step (small models flatten the objects). Empty steps are
 * dropped; an empty list clears the plan.
 */
export function normalizePlanItems(raw: unknown): PlanItem[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      "plan.update: `items` must be an array of { step, status } (send [] to clear the plan)",
    );
  }
  if (raw.length > PLAN_MAX_ITEMS) {
    throw new Error(
      `plan.update: at most ${PLAN_MAX_ITEMS} items (got ${raw.length}); merge small steps into bigger ones`,
    );
  }
  const items: PlanItem[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry === "string") {
      const step = cleanPlanStep(entry);
      if (step.length > 0) items.push({ step, status: "pending" });
      continue;
    }
    if (entry === null || typeof entry !== "object") {
      throw new Error(`plan.update: item ${index + 1} must be { step, status }`);
    }
    const record = entry as Record<string, unknown>;
    const text = typeof record.step === "string" ? record.step : "";
    const step = cleanPlanStep(text);
    if (step.length === 0) continue;
    const status =
      record.status === undefined ? "pending" : parsePlanItemStatus(record.status);
    if (status === null) {
      throw new Error(
        `plan.update: item ${index + 1} has status ${JSON.stringify(record.status)}; use "pending", "in_progress" or "done"`,
      );
    }
    items.push({ step, status });
  }
  return items;
}

/** Two snapshots draw the same checklist (timestamps ignored). */
export function samePlanItems(
  a: PlanSnapshot | null | undefined,
  b: PlanSnapshot | null | undefined,
): boolean {
  const left = a?.items ?? [];
  const right = b?.items ?? [];
  if (left.length !== right.length) return false;
  return left.every(
    (item, i) => item.step === right[i]!.step && item.status === right[i]!.status,
  );
}

/**
 * Read a stored snapshot back defensively: sessions are JSON on disk and
 * a hand-edited or older file must not crash a reopen. `null` when the
 * value is not a usable plan.
 */
export function readPlanSnapshot(raw: unknown): PlanSnapshot | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.items)) return null;
  let items: PlanItem[];
  try {
    items = normalizePlanItems(record.items.slice(0, PLAN_MAX_ITEMS));
  } catch {
    return null;
  }
  if (items.length === 0) return null;
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : 0;
  return { items, updatedAt };
}

const STATUS_MARK: Readonly<Record<PlanItemStatus, string>> = {
  done: "[x]",
  in_progress: "[>]",
  pending: "[ ]",
};

/**
 * The plan as the model reads it back in the `plan.update` result: one
 * line of progress and one line per step. Short on purpose; the model
 * just wrote the list.
 */
export function renderPlanForModel(s: PlanSnapshot): string {
  if (s.items.length === 0) return "Plan cleared.";
  const { done, total } = planProgress(s);
  const lines = [`Plan ${done}/${total} done.`];
  for (const item of s.items) lines.push(`${STATUS_MARK[item.status]} ${item.step}`);
  return lines.join("\n");
}

/** Most open steps the turn-start reminder names before counting the rest. */
const REMINDER_MAX_STEPS = 5;

/**
 * The turn-boundary nudge (ATO-486): one short `### notice` on the first
 * step of a turn whose session still has an unfinished plan, so the
 * model either carries on with it or says it is dropped. `undefined`
 * when there is nothing to remind about. Cheap: a few lines, once per
 * turn, never while the plan is complete.
 */
export function planReminderNotice(
  s: PlanSnapshot | null | undefined,
): string | undefined {
  if (!planHasOpenItems(s)) return undefined;
  const plan = s!;
  const { done, total } = planProgress(plan);
  const open = plan.items.filter((item) => item.status !== "done");
  const named = open
    .slice(0, REMINDER_MAX_STEPS)
    .map((item) => `${STATUS_MARK[item.status]} ${item.step}`);
  if (open.length > REMINDER_MAX_STEPS) {
    named.push(`…and ${open.length - REMINDER_MAX_STEPS} more`);
  }
  return [
    `[plan] Your plan is ${done}/${total} done. Still open:`,
    ...named,
    "Keep it current with plan.update (send the whole list). If this message starts something else, replace the plan or clear it with items: [].",
  ].join("\n");
}
