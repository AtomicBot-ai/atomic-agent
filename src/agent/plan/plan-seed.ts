import {
  cleanPlanStep,
  PLAN_MAX_ITEMS,
  type PlanSnapshot,
} from "./plan-snapshot.js";

/**
 * Seeding the live plan from an approved plan-mode reply (ATO-486).
 *
 * Plan mode ends with the model's plan as prose, and "run it" carries
 * it out. A model that calls `plan.update` replaces the seed on its
 * first call; a small model that never calls the tool still gets a
 * checklist on screen, made of exactly the steps it wrote, and nothing
 * else: the harness never invents steps. A reply with no list in it
 * seeds nothing.
 */

/** `1.`, `1)`, `Step 1:` / `Step 1 -` at the start of a top-level line. */
const NUMBERED = /^(?:step\s+)?\d{1,2}\s*[.):-]\s+(.+)$/i;
/** `-`, `*`, `+`, `•` bullets, optionally with a `[ ]` / `[x]` box. */
const BULLET = /^[-*+•]\s+(?:\[[ xX]\]\s+)?(.+)$/;
/** At most this much indentation still counts as a top-level item. */
const MAX_TOP_LEVEL_INDENT = 3;

/**
 * The steps of the first list in `text`: numbered items when there are
 * at least two, otherwise bullet items when there are at least two,
 * otherwise none. Nested items, code blocks and headings are skipped.
 */
export function parsePlanSteps(text: string): string[] {
  const numbered: string[] = [];
  const bullets: string[] = [];
  let inFence = false;
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent > MAX_TOP_LEVEL_INDENT) continue;
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const n = NUMBERED.exec(line);
    if (n) {
      const step = cleanStepText(n[1]!);
      if (step.length > 0) numbered.push(step);
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      const step = cleanStepText(b[1]!);
      if (step.length > 0) bullets.push(step);
    }
  }
  const picked = numbered.length >= 2 ? numbered : bullets.length >= 2 ? bullets : [];
  return picked.slice(0, PLAN_MAX_ITEMS);
}

/** Drop markdown emphasis and inline-code ticks; keep the words. */
function cleanStepText(raw: string): string {
  return cleanPlanStep(
    raw
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1"),
  );
}

/**
 * The checklist an approved plan seeds: its steps, all pending, the
 * first one in progress. `null` when the reply holds no list.
 */
export function seedPlanFromReply(text: string, now: number): PlanSnapshot | null {
  const steps = parsePlanSteps(text);
  if (steps.length === 0) return null;
  return {
    items: steps.map((step, index) => ({
      step,
      status: index === 0 ? ("in_progress" as const) : ("pending" as const),
    })),
    updatedAt: now,
  };
}
