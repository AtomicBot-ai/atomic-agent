import type { CompressedToolResult } from "../compressor/result-compressor.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

/**
 * Plan mode: the agent may look, but not touch.
 *
 * Every tool already declares whether it mutates anything —
 * `ToolDefinition.readonly` — and until now that flag was surfaced over
 * HTTP (`route-capabilities.ts`) and enforced nowhere. This is the
 * enforcement.
 *
 * **Why a gate and not an approval level.** The ladder answers "does
 * this need to ask first", and its top and bottom are both wrong for
 * planning: level 1 asks about every mutation, which is a stream of
 * prompts for work the operator has explicitly said they do not want
 * done yet, and answering them all with "no" teaches the model nothing
 * except that its tools are broken. Plan mode is a different question —
 * "is this the kind of thing we are doing right now" — and the honest
 * answer is a refusal the model can read and act on, not a prompt.
 *
 * **What still runs.** Every read-only tool: the whole `os.fs.read` /
 * `grep` / `glob` / `git.*` surface, web search and fetch, memory
 * recall, `skill.view`, `tool.view`. That is deliberate and is most of
 * what planning *is* — the agent needs to read the code before it can
 * say what it would change.
 *
 * **What never gets gated.** Terminal verbs. `reply` and `finish` are
 * how the plan reaches the operator, and a mode whose purpose is to
 * produce a plan cannot be allowed to block the sentence that delivers
 * it. They are also the only tools whose refusal would strand a turn:
 * the loop ends when a terminal verb runs, so vetoing one is vetoing
 * the exit.
 */

/**
 * Terminal verbs, which plan mode never touches. Duplicated from the
 * executor's own notion of `resourceClass: "terminal"` rather than
 * imported, because this module is consulted before a call is
 * classified — and because the list being short and explicit is worth
 * more here than the indirection would be.
 */
const TERMINAL_TOOLS: ReadonlySet<string> = new Set(["reply", "finish"]);

export interface PlanModeVerdict {
  /** False when the call must not reach the registry. */
  allowed: boolean;
  /** The result to fill the call's slot with. Present iff `allowed` is false. */
  refusal?: CompressedToolResult;
}

/**
 * Decide whether `tool` may run while plan mode is on.
 *
 * A tool the registry does not know is allowed through untouched: the
 * step executor has its own unknown-tool path with a better message,
 * and answering "not in plan mode" to a typo would send the model
 * looking for a mode switch instead of a spelling mistake.
 */
export function checkPlanMode(
  tool: string,
  registry: Pick<ToolRegistry, "get" | "has">,
): PlanModeVerdict {
  if (TERMINAL_TOOLS.has(tool)) return { allowed: true };
  // `has` before `get`, because `get` throws for an unknown name.
  if (!registry.has(tool)) return { allowed: true };
  if (registry.get(tool).readonly) return { allowed: true };
  return { allowed: false, refusal: refusalFor(tool) };
}

/**
 * What the model is told.
 *
 * Three things, in the order they are useful: that the call did not
 * happen, why, and what to do instead. The last one is the part that
 * decides whether plan mode works — a bare "not permitted" reads as a
 * broken tool, and a model that thinks its tools are broken retries
 * them. Naming the exit ("say what you would do, then stop") turns the
 * refusal into an instruction.
 */
export function refusalFor(tool: string): CompressedToolResult {
  return {
    tool,
    status: "error",
    summary:
      `plan mode is on, so \`${tool}\` was not run — nothing is being ` +
      `changed yet. Keep reading (every read-only tool still works) and ` +
      `then reply with the plan: what you would change, where, and in ` +
      `what order. The operator switches out of plan mode to let you ` +
      `carry it out.`,
    details: { plan_mode: true, tool },
    truncated: false,
  };
}
