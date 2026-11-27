import { ModelError } from "./llm-failures.js";

/** How far down a `cause` chain the model failure is looked for. */
const MAX_CAUSE_DEPTH = 6;

/**
 * A turn that ended because the model looped twice in a row (ATO-1678):
 * its reply was cut at the length limit while repeating one block of
 * text, the step was retried with a notice naming the loop and telling
 * it not to repeat, and the retry looped and was cut again
 * (`ModelError.repeatedCut === "loop"`, `repeated-truncation.ts`).
 *
 * That is the model getting stuck, not a defect of the agent: the cap
 * did not cause the loop (a bigger one only buys a longer loop), the
 * agent already gave the one retry and the person is told "The model got
 * stuck repeating the same text". So error reporting leaves it out, as
 * it does a near-miss unknown-tool streak (ATO-1674). The trace and the
 * `completion truncated` log lines still record both cuts.
 *
 * Only `loop`. A reply cut twice without looping (a long think block, a
 * tool call too big for the cap) still reports, with its `cut_part` and
 * `cut_repeated` tags: the cap or the notice can be ours to fix.
 */
export function isRepeatedModelLoop(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof ModelError) return current.repeatedCut === "loop";
    if (!(current instanceof Error)) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
