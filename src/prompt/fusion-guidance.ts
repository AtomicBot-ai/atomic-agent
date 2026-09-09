/**
 * The `### fusion` section of the stable prefix.
 *
 * Fusion's whole economics — cloud tokens for the thinking, local
 * tokens for the bulk — depend on the orchestrator actually reaching
 * for `fusion.delegate`. A cloud model handed one more tool in a
 * catalog of forty will read all forty files itself and never fan
 * anything out, so the tool without this block buys nothing.
 *
 * The lines are chosen for the two ways delegation goes wrong. First,
 * *what* to delegate: models delegate the design and keep the typing,
 * which is exactly backwards — the orchestrator is the expensive,
 * capable one and must keep judgement, integration and review. Second,
 * *how* to write the brief: a worker has no memory of this
 * conversation, so an instruction like "do the other two the same way"
 * produces a confidently wrong result rather than a question.
 *
 * Placement mirrors `composio-guidance.ts`: a `### fusion` block after
 * `### integrations` and before `### instructions`, present only when
 * the descriptor is mounted, so an install that never runs fusion has a
 * byte-identical prefix (`build-prompt.test.ts` pins those bytes).
 */

import type { ToolDescriptor } from "./stable-prefix.js";

/** The tool whose presence means the fan-out is available this boot. */
export const FUSION_DELEGATE_TOOL = "fusion.delegate";

/**
 * Live iff the delegate tool is in the catalog. Derived from the
 * descriptors rather than passed as a flag, so the guidance cannot
 * drift out of sync with what actually got mounted.
 */
export function isFusionActive(descriptors: readonly ToolDescriptor[]): boolean {
  return descriptors.some((d) => d.name === FUSION_DELEGATE_TOOL);
}

export const FUSION_GUIDANCE = [
  "You orchestrate local worker agents: you plan and they execute. Decide the approach first, then delegate the independent bulk — reading many files, first drafts, boilerplate, tests, wide searches — with `fusion.delegate`.",
  "Each task's `instructions` must stand alone: exact paths, what counts as done, and the format of the answer you want back. Workers have no memory of this conversation and cannot ask you anything.",
  "Keep the design, the integration and the review yourself. Never delegate the decision you are being asked to make.",
  "Call `fusion.delegate` on its own, never alongside other tool calls in the same array — it runs several turns internally and takes a while.",
  "Read every reply before you use it: verify what came back, merge it yourself, and redo or re-delegate any part that came back `failed` or `needs_orchestrator`.",
  "Workers cannot reach the user and cannot get approval, so anything that needs a person — a shell command, a write at a low approval level — comes back to you to run.",
].join("\n");
