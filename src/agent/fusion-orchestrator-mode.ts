import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { MCP_TOOL_PREFIX } from "../mcp/mcp-resource-class.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

/**
 * Fusion's division of labour, enforced instead of merely asked for.
 *
 * In fusion mode the orchestrator plans, splits the job, briefs the
 * workers, reads what comes back, judges it, and sends weak parts out
 * again. The workers do the doing. The `### fusion` block has said so
 * since the mode shipped, and a capable cloud model handed a catalog of
 * forty tools still builds the thing itself.
 *
 * **What the first version of this gate got wrong.** It opened for the
 * rest of the turn as soon as one `fusion.delegate` call completed —
 * and `fusion.delegate` returns `ok` even when every worker failed, by
 * design (partial results are the value of a fan-out). A real session
 * proved the consequence: the fan-out came back with one task
 * `needs_orchestrator` and two `cancelled`, and the orchestrator then
 * wrote fifteen files and ran five commands itself. The gate permitted
 * every one of them. A latch that opens on "something was attempted"
 * is not a rule about who does the work.
 *
 * **The rule now: nothing.** The orchestrator does not mutate anything,
 * in any circumstance, for the whole turn. Read, delegate, reply.
 *
 * The version before this one allowed a mutation while the turn held a
 * task returned `needs_orchestrator` — work a worker could not do
 * because it had no operator to ask. A session showed why that fails:
 * FOUR of six tasks came back that way, because at approval level 1 a
 * worker cannot write at all, and each of their replies said "the
 * orchestrator must run these steps". The escape hatch became the main
 * road, and thirteen writes went through it.
 *
 * That hole is closed at its source instead — the operator now
 * authorises a fan-out once and its workers write inside a named
 * directory (`approval/fanout-scope.ts`), so `needs_orchestrator` means
 * "this needs a wider scope than you approved", and the answer to it is
 * another fan-out, not a takeover.
 *
 * **Why a refusal and not a hidden tool.** Descriptor visibility is not
 * capability: the only membership check at execution is against the
 * registry, and a model that writes a tool call as text still reaches
 * `registry.invoke` through the step executor's JSON fallback. Hiding
 * the descriptor would also rewrite the stable prefix and drop the
 * session's KV cache. A refusal costs one tool result, reads as an
 * instruction, and cannot be walked around.
 *
 * **What is never gated:** read-only tools (planning *is* reading),
 * `fusion.delegate` itself, and the terminal verbs — vetoing `reply`
 * would veto the turn's own exit.
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

/**
 * What this turn has done so far. Held by `runTurn`, advanced by the
 * batch executor as each fan-out returns.
 */
export interface FusionOrchestratorState {
  /**
   * Completed `fusion.delegate` calls this turn, however they went.
   * Nothing is unlocked by it — it only shapes the refusal, which reads
   * differently before the first fan-out ("plan and delegate") and after
   * one ("send the rework back out").
   */
  delegations: number;
  /**
   * Consecutive fan-outs in which **no worker executed a single step**.
   * Reset by any fan-out that ran something, however badly it went.
   *
   * This is the difference between "the workers did the job wrong" and
   * "the workers never ran", and only the second one is unfixable by
   * re-briefing. It happens for reasons outside the model's reach: the
   * managed daemon failed to bind its port and every request was
   * refused, the leg was pointed at a server that is not there, the
   * turn was cancelled before the first wave got a slot.
   */
  barrenDelegations: number;
}

/**
 * Barren fan-outs tolerated before the refusal stops asking for another
 * one. Two, not one: a single all-cancelled fan-out is what an operator
 * pressing Esc looks like, and telling the model to give up on that
 * would be wrong. Two in a row is a broken leg.
 */
export const BARREN_DELEGATION_LIMIT = 2;

/** A turn that has not delegated yet. */
export function emptyFusionOrchestratorState(): FusionOrchestratorState {
  return { delegations: 0, barrenDelegations: 0 };
}

/**
 * Whether a call changes anything outside this process.
 *
 * `registry.readonly` for native tools, which declare it honestly. NOT
 * for MCP tools: theirs is derived from the server's own
 * `readOnlyHint` / `destructiveHint` (`mcp-tool-adapter.ts`), which is
 * third-party wire data — the adapter's own comment says it cannot be
 * trusted for batch safety, and a gate about who may change the world
 * has even less business trusting it. An MCP tool is treated as
 * mutating whatever it claims, which fails closed: the cost is that an
 * orchestrator cannot call a genuinely read-only MCP tool before it
 * delegates, and the alternative is a server that opts itself out of
 * the rule by shipping one flag.
 */
function mutates(tool: string, registry: Pick<ToolRegistry, "get">): boolean {
  if (tool.startsWith(MCP_TOOL_PREFIX)) return true;
  return !registry.get(tool).readonly;
}

/** What the gate needs to answer "would this call be refused". */
export interface FusionGateContext {
  registry: Pick<ToolRegistry, "get" | "has">;
}

/**
 * The one predicate behind the gate: would an ORCHESTRATOR turn refuse
 * `toolName`? Shared by `checkFusionOrchestrator` (the refusal at
 * dispatch), the step executor's batch trim (which must not keep a call
 * the gate is about to refuse) and the per-request grammar (which must
 * not let a local orchestrator generate one). One predicate, so the
 * three can never disagree about which call survives.
 *
 * The verdict does not depend on turn state — `delegations` only shapes
 * the refusal text — so the context is the registry alone.
 */
export function wouldRefuse(toolName: string, ctx: FusionGateContext): boolean {
  if (TERMINAL_TOOLS.has(toolName) || toolName === DELEGATE_TOOL) return false;
  if (!ctx.registry.has(toolName)) return false;
  return mutates(toolName, ctx.registry);
}

/**
 * Decide whether `tool` may run on the orchestrator's own turn.
 *
 * An unknown tool is allowed through untouched, for the reason plan
 * mode does the same: the step executor's unknown-tool path has the
 * better message, and answering "delegate first" to a typo sends the
 * model looking for the wrong problem.
 */
export function checkFusionOrchestrator(
  tool: string,
  registry: Pick<ToolRegistry, "get" | "has">,
  state: FusionOrchestratorState,
): FusionOrchestratorVerdict {
  if (!wouldRefuse(tool, { registry })) return { allowed: true };
  return { allowed: false, refusal: refusalFor(tool, state) };
}

/**
 * The subset of `names` the gate would refuse — see `wouldRefuse`. What
 * lets a local orchestrator's per-request grammar drop the tools the
 * gate would refuse (the descriptors stay in the prompt; only the
 * sampler's vocabulary shrinks).
 */
export function refusedToolNames(
  names: Iterable<string>,
  ctx: FusionGateContext,
): Set<string> {
  const refused = new Set<string>();
  for (const name of names) {
    if (wouldRefuse(name, ctx)) refused.add(name);
  }
  return refused;
}

/**
 * What the model is told.
 *
 * Two different sentences, because the model is in two different
 * situations and the exit is different in each. Before any fan-out the
 * instruction is "plan and delegate". After one, the model is holding
 * results it does not like — and the thing it must not conclude is
 * "the tool is broken, I will do it myself", which is exactly what it
 * did when this gate let it. So that branch names the rework loop and
 * says what a re-delegation brief should carry.
 */
export function refusalFor(
  tool: string,
  state: FusionOrchestratorState,
): CompressedToolResult {
  const summary =
    state.barrenDelegations >= BARREN_DELEGATION_LIMIT
      ? `\`${tool}\` was not run, and neither did the workers: the last ` +
        `${state.barrenDelegations} fan-outs came back with every task ` +
        `having executed zero steps. That is not a briefing problem and ` +
        `another \`fusion.delegate\` will not fix it — the worker leg is ` +
        `not serving. Stop here and tell the operator exactly that, ` +
        `naming what you were trying to build and what you still need ` +
        `from them: the local llama-server may have failed to start (a ` +
        `port already in use is the common one, check its log), or the ` +
        `worker leg may point at a server that is not running.`
      : state.delegations === 0
        ? `fusion is on, so \`${tool}\` was not run: you plan, the workers ` +
          `build. Finish reading — every read-only tool still works — ` +
          `decide the approach, then call \`fusion.delegate\` with one task ` +
          `per independent part, each naming the exact paths it produces in ` +
          `\`files\`, what counts as done, and the answer format you want.`
        : `\`${tool}\` was not run. You have delegated ${state.delegations} ` +
          `time(s) this turn; building the result yourself is the one thing ` +
          `this mode exists to prevent, however the last fan-out went. Send ` +
          `it out again with \`fusion.delegate\`: say what was wrong with ` +
          `the previous attempt, what to change, and what "good" looks ` +
          `like. Split a part that timed out into smaller ones. A task that ` +
          `came back \`needs_orchestrator\` was blocked by an approval — ` +
          `re-send it with the paths in \`files\` so the operator can ` +
          `authorise that directory when the fan-out asks.`;
  return {
    tool,
    status: "error",
    summary,
    details: {
      fusion_orchestrator: true,
      tool,
      delegations: state.delegations,
    },
    truncated: false,
  };
}

/**
 * Did this fan-out run anything at all?
 *
 * Read off the per-task rows rather than the outcome: `all_failed`
 * covers both a wave that ran and failed and a wave that never started,
 * and only the step counts tell them apart. Unreadable details (a shape
 * this function does not recognise) count as work, which fails toward
 * the old behaviour — the refusal keeps asking for a rework rather than
 * telling the model to stop on a signal it could not actually read.
 */
export function delegationProducedWork(result: {
  details?: Record<string, unknown> | undefined;
}): boolean {
  const tasks = result.details?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return true;
  return tasks.some((task) => {
    if (typeof task !== "object" || task === null) return true;
    const steps = (task as { stepCount?: unknown }).stepCount;
    return typeof steps !== "number" || steps > 0;
  });
}

/**
 * Count a completed `fusion.delegate` call.
 *
 * Nothing in the result can unlock a mutation — that was and stays the
 * gate's rule. What it does now read is whether the fan-out executed
 * anything, because a refusal that tells the model to re-delegate into
 * a leg that is not running is an instruction to loop forever.
 */
export function recordDelegation(
  state: FusionOrchestratorState,
  producedWork = true,
): FusionOrchestratorState {
  return {
    delegations: state.delegations + 1,
    barrenDelegations: producedWork ? 0 : state.barrenDelegations + 1,
  };
}
