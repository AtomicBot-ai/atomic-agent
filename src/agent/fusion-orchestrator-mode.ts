import type { CompressedToolResult } from "../compressor/result-compressor.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

/**
 * Fusion's division of labour, enforced instead of merely asked for.
 *
 * In fusion mode the expensive cloud model is the orchestrator and the
 * local ones are the hands: it decides the approach, splits the work,
 * writes a self-contained brief per worker, reads what comes back,
 * integrates it, and sends rework back out. The `### fusion` block has
 * said so since the mode shipped — and a capable cloud model, handed a
 * catalog of forty tools, still reads the twelve files itself and never
 * fans anything out. Advice does not hold against that; the model is
 * doing what it is good at.
 *
 * So the first mutation of a fusion turn is refused until the turn has
 * delegated at least once. Read the code, plan, then send the doing to
 * the workers.
 *
 * **Why a refusal and not a hidden descriptor.** Removing tools from the
 * catalog mid-turn rewrites the stable prefix and drops the session's KV
 * cache (see `effectiveToolDescriptors` in bootstrap). A refusal costs
 * one tool result and reads as an instruction — the same trade plan mode
 * makes, and the same one `fusion.delegate` already makes when a worker
 * calls it.
 *
 * **Why it lifts after the first fan-out.** Two things genuinely belong
 * to the orchestrator afterwards: integration — merging what came back,
 * which is a write it must be able to make — and anything a worker
 * handed up because it needed approval, which workers cannot request
 * (`FUSION_WORKER_APPROVAL_REFUSED`). Keeping the gate closed for the
 * whole turn would strand both. Rework goes back to the workers because
 * the guidance says so; that part stays advice, because "this write is
 * rework rather than integration" is not a thing the runtime can see.
 *
 * **What is never gated:** read-only tools (planning *is* reading),
 * `fusion.delegate` itself, and the terminal verbs — vetoing `reply`
 * would veto the turn's exit.
 */

/** Terminal verbs, never gated. Mirrors `plan-mode.ts`, deliberately. */
const TERMINAL_TOOLS: ReadonlySet<string> = new Set(["reply", "finish"]);

/** The fan-out itself: the one call this gate exists to steer towards. */
const DELEGATE_TOOL = "fusion.delegate";

export interface FusionOrchestratorVerdict {
  /** False when the call must not reach the registry. */
  allowed: boolean;
  /** The result to fill the call's slot with. Present iff `allowed` is false. */
  refusal?: CompressedToolResult;
}

export interface FusionOrchestratorState {
  /** Whether this turn has already completed a `fusion.delegate` call. */
  delegated: boolean;
}

/**
 * Decide whether `tool` may run on the orchestrator's own turn.
 *
 * An unknown tool is allowed through untouched, for the reason plan mode
 * does the same: the step executor's unknown-tool path has the better
 * message, and answering "delegate first" to a typo sends the model
 * looking for the wrong problem.
 */
export function checkFusionOrchestrator(
  tool: string,
  registry: Pick<ToolRegistry, "get" | "has">,
  state: FusionOrchestratorState,
): FusionOrchestratorVerdict {
  if (state.delegated) return { allowed: true };
  if (TERMINAL_TOOLS.has(tool) || tool === DELEGATE_TOOL) {
    return { allowed: true };
  }
  if (!registry.has(tool)) return { allowed: true };
  if (registry.get(tool).readonly) return { allowed: true };
  return { allowed: false, refusal: refusalFor(tool) };
}

/**
 * What the model is told.
 *
 * Same three parts plan mode's refusal has, in the same order: the call
 * did not happen, why, and the exit. The exit is the whole point — a
 * bare "not permitted" reads as a broken tool and gets retried, while
 * naming the shape of the brief turns the refusal into the instruction
 * the orchestrator needed in the first place.
 */
export function refusalFor(tool: string): CompressedToolResult {
  return {
    tool,
    status: "error",
    summary:
      `fusion is on and this turn has not delegated yet, so \`${tool}\` ` +
      `was not run. You are the orchestrator: the local workers do the ` +
      `doing. Finish reading (every read-only tool still works), decide ` +
      `the approach, then split the work and call \`fusion.delegate\` ` +
      `— one task per independent part, each with the exact paths, what ` +
      `counts as done, and the answer format you want back. Once the ` +
      `workers report, you can write again: merge their results, and ` +
      `send rework back out rather than doing it yourself.`,
    details: { fusion_orchestrator: true, tool, delegated: false },
    truncated: false,
  };
}
