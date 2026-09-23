import type { CompressedToolResult } from "../compressor/result-compressor.js";
import type { ToolDescriptor } from "../prompt/stable-prefix.js";

/**
 * A per-step tool set: the only names this step may emit or run.
 *
 * The reserved final step narrows a step to `reply` / `finish` through
 * `terminalOnly`; this is the same restriction with the names and the
 * reason supplied by the caller, so one step can be held to any subset
 * of the catalog without touching the prompt. It has the final step's
 * three legs: the per-request grammar admits only these names (a local
 * model cannot generate another — `stepGrammarToolNames`), the native
 * tools payload lists only their descriptors (a cloud model is not
 * offered another — `narrowDescriptorsToToolSet`), and the batch
 * executor refuses a call outside the set before dispatch (a call that
 * arrived as text still does not run — `runFinalStepGate`). The
 * `### tools` catalog is left as it is: stable-prefix bytes, and a
 * narrowed catalog moved the session to a cold slot.
 *
 * First user: the stalled Fusion review (`review-stall.ts`).
 */
export interface StepToolSet {
  names: readonly string[];
  /** One clause naming why, opening the refusal the model reads. */
  reason: string;
}

/** Whether `tool` is one of the set's names. */
export function toolSetAdmits(set: StepToolSet, tool: string): boolean {
  return set.names.includes(tool);
}

/**
 * The descriptors the set admits. Returns `descriptors` ITSELF when
 * nothing is removed: the native-tools adapter memoises its conversion
 * on the array's identity, and a fresh array for an unchanged list would
 * only defeat that.
 */
export function narrowDescriptorsToToolSet(
  descriptors: readonly ToolDescriptor[],
  set: StepToolSet,
): readonly ToolDescriptor[] {
  if (descriptors.every((d) => toolSetAdmits(set, d.name))) return descriptors;
  return descriptors.filter((d) => toolSetAdmits(set, d.name));
}

/**
 * The tool result a call outside the set gets instead of running. Names
 * the reason first — the model has read it in `### notice` already and
 * the repetition is what ties the refusal to it — then the exits.
 */
export function toolSetRefusal(
  tool: string,
  set: StepToolSet,
): CompressedToolResult {
  const admitted = set.names.map((name) => `\`${name}\``).join(", ");
  return {
    tool,
    status: "error",
    summary: `${set.reason}: \`${tool}\` was not run; this step admits only ${admitted}`,
    details: { tool_set: true, tool, admitted: [...set.names] },
    truncated: false,
  };
}
