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
 * Third — and this is why the block carries numbers at all — *how many*
 * to send. The width of a fan-out is the orchestrator's call now, not
 * `llm.runMode.fusion.workers`, and a model choosing over hardware it
 * cannot see has nothing to choose with. So the last line states what
 * this machine actually serves (see `fusion-machine-facts.ts`): the
 * llama-server slot count, the local model behind it, and therefore how
 * many workers run at once before the rest queue.
 *
 * Placement mirrors `composio-guidance.ts`: a `### fusion` block after
 * `### integrations` and before `### instructions`, present only when
 * the descriptor is mounted, so an install that never runs fusion has a
 * byte-identical prefix (`build-prompt.test.ts` pins those bytes).
 */

import {
  NO_FUSION_MACHINE_FACTS,
  type FusionMachineFacts,
} from "./fusion-machine-facts.js";
import type { ToolDescriptor } from "./stable-prefix.js";

/**
 * The tool whose presence means the fan-out is available right now.
 * Not "this boot": the runtime resolves the descriptor gate live, so
 * the block appears and disappears with the effective run mode.
 */
export const FUSION_DELEGATE_TOOL = "fusion.delegate";

/**
 * Live iff the delegate tool is in the catalog. Derived from the
 * descriptors rather than passed as a flag, so the guidance cannot
 * drift out of sync with what actually got mounted.
 */
export function isFusionActive(
  descriptors: readonly ToolDescriptor[],
): boolean {
  return descriptors.some((d) => d.name === FUSION_DELEGATE_TOOL);
}

/**
 * The behavioural lines — everything that is true on any machine.
 *
 * Exported as the base so tests and callers with no facts to hand get
 * exactly the block a machine-less build renders.
 */
export const FUSION_GUIDANCE = [
  "You orchestrate the workers: read enough to decide, plan, delegate the doing, review what comes back.",
  "Plan in the open, then delegate in the same turn — never stop at the plan: list the independent, self-contained parts, sized so a big one gets its own worker and small ones share.",
  "One task per part, in one `fusion.delegate` call. List the paths a task will produce in its `files` — the operator is asked once, about those directories, and that answer is what lets the workers write. Each `instructions` must stand alone: workers have no memory of this conversation and cannot ask you anything.",
  "You choose `maxWorkers` per call; prefer sending more parts over doing any yourself.",
  "Tools that change things are refused for you, always: the workers build, you do not. That is the mode working, not a fault.",
  "Keep the design and the judgement: read every reply against its brief.",
  "Rework goes back out: anything `failed`, `cancelled`, `needs_orchestrator` or just not good enough is another `fusion.delegate` saying what was wrong and what good looks like. Keep going until you would sign off on it.",
  "Yours alone: the decision you were asked for, a part that only makes sense with this conversation in front of it, and anything needing operator approval — workers cannot reach the user.",
  "Call `fusion.delegate` on its own, never alongside other tool calls — it runs several turns internally.",
].join("\n");

/**
 * The one line that differs per machine. Each clause is dropped whole
 * when its fact is unknown, and the line itself when none are known:
 * a sentence with a hole in it reads as a fact the model can lean on.
 */
export function formatFusionMachineLine(
  facts: FusionMachineFacts,
): string | null {
  const { workerSlots, workerModel } = facts;
  const on = workerModel === null ? "" : ` \`${workerModel}\``;
  if (workerSlots !== null) {
    const slots = `${workerSlots} request slot${workerSlots === 1 ? "" : "s"}`;
    return `This machine: workers run${on} on a local llama-server with ${slots}, so up to ${workerSlots} run at once and any beyond that queue behind them.`;
  }
  if (workerModel !== null) {
    return `This machine: workers run${on} on a local llama-server.`;
  }
  return null;
}

/**
 * The rendered `### fusion` body: the behavioural lines, plus the
 * machine line when anything about the machine is known.
 *
 * Deterministic for a given `facts` — these bytes live in the
 * KV-cache-hot stable prefix and must not move between steps.
 */
export function buildFusionGuidance(
  facts: FusionMachineFacts = NO_FUSION_MACHINE_FACTS,
): string {
  const machine = formatFusionMachineLine(facts);
  return machine === null ? FUSION_GUIDANCE : `${FUSION_GUIDANCE}\n${machine}`;
}
