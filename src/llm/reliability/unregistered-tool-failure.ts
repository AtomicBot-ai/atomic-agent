import { ToolExecutionError } from "./llm-failures.js";

/** How far down a `cause` chain the streak error is looked for. */
const MAX_CAUSE_DEPTH = 6;

/**
 * A turn the unknown-tool streak ended (`step-unknown-tools.ts`) on a
 * near miss: the model kept calling a name close to a real tool, every
 * call got an error result naming the closest real tools, and after
 * `UNKNOWN_TOOL_STREAK_LIMIT` such steps in a row the turn stopped.
 *
 * That is a model mistake the agent already handled, not a defect of
 * the agent, so error reporting leaves it out (ATO-1674), as it does a
 * provider plan's own limit (ATO-1283). The person still sees the
 * failed turn; the trace and the `call names a tool this agent does not
 * have` log line still record each step.
 *
 * Only `nameClass: "near_miss"`. A streak on an `mcp_like` or `other`
 * name still reports: such a name can be a tool the prompt shows but
 * the registry lacks (a server that went down, a catalog out of step),
 * which is ours to fix. Any other `ToolExecutionError` still reports.
 */
export function isUnregisteredToolStreak(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof ToolExecutionError) {
      return current.kind === "unregistered" && current.nameClass === "near_miss";
    }
    if (!(current instanceof Error)) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
