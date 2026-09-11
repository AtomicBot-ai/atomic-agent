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
 * **The rule now.** A mutation is allowed only while the turn is
 * holding work a worker physically could not do — a task that came back
 * `needs_orchestrator`, which is what a worker reports when it hit an
 * approval it cannot request (`FUSION_WORKER_APPROVAL_REFUSED`). That
 * is the one thing the orchestrator has that the workers do not: a
 * person at the other end. Everything else — the first draft, the
 * rewrite, the file the worker timed out on — goes back out as another
 * fan-out.
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
  /** Completed `fusion.delegate` calls this turn, however they went. */
  delegations: number;
  /**
   * Tasks that came back `needs_orchestrator` — a worker stopped
   * because it needed an approval it cannot ask for. This, and only
   * this, is what unlocks a mutation: the work a worker could not do
   * because it has no person to ask.
   */
  handedUp: number;
}

/** A turn that has not delegated yet. */
export function emptyFusionOrchestratorState(): FusionOrchestratorState {
  return { delegations: 0, handedUp: 0 };
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
  if (TERMINAL_TOOLS.has(tool) || tool === DELEGATE_TOOL) {
    return { allowed: true };
  }
  if (!registry.has(tool)) return { allowed: true };
  if (!mutates(tool, registry)) return { allowed: true };
  if (state.handedUp > 0) return { allowed: true };
  return { allowed: false, refusal: refusalFor(tool, state) };
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
    state.delegations === 0
      ? `fusion is on and this turn has not delegated yet, so \`${tool}\` was ` +
        `not run. You are the orchestrator: the workers do the doing. ` +
        `Finish reading — every read-only tool still works — decide the ` +
        `approach, then split the work and call \`fusion.delegate\`: one ` +
        `task per independent part, each with the exact paths, what counts ` +
        `as done, and the answer format you want back.`
      : `\`${tool}\` was not run. You have delegated ${state.delegations} ` +
        `time(s) this turn and no worker handed anything up, so there is ` +
        `nothing here that only you can do — doing the work yourself is ` +
        `the one thing this mode exists to prevent. If a part came back ` +
        `\`failed\`, \`cancelled\` or weak, send it out again with ` +
        `\`fusion.delegate\`: say what was wrong with the last attempt, ` +
        `what to change, and what "good" looks like. Split a part that ` +
        `timed out into smaller ones. Only work a worker returned as ` +
        `\`needs_orchestrator\` is yours to run.`;
  return {
    tool,
    status: "error",
    summary,
    details: {
      fusion_orchestrator: true,
      tool,
      delegations: state.delegations,
      handed_up: state.handedUp,
    },
    truncated: false,
  };
}

/**
 * Fold a completed `fusion.delegate` result into the turn's ledger.
 *
 * Reads the per-task statuses out of the tool result rather than being
 * told by the caller: the executor sees the `CompressedToolResult` and
 * nothing else, and a count passed alongside could drift from the
 * result the model is reading in the same step.
 */
export function recordDelegation(
  state: FusionOrchestratorState,
  result: CompressedToolResult,
): FusionOrchestratorState {
  const tasks = (result.details as { tasks?: unknown } | undefined)?.tasks;
  const handedUp = Array.isArray(tasks)
    ? tasks.filter(
        (task) =>
          (task as { status?: unknown } | null)?.status === "needs_orchestrator",
      ).length
    : 0;
  return {
    delegations: state.delegations + 1,
    handedUp: state.handedUp + handedUp,
  };
}
