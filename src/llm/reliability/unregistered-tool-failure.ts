import { ToolExecutionError } from "./llm-failures.js";

/** How far down a `cause` chain the streak error is looked for. */
const MAX_CAUSE_DEPTH = 6;

/**
 * A turn the unknown-tool streak ended (`step-unknown-tools.ts`): the
 * model kept calling tools the agent does not have, every call got an
 * error result naming the closest real tools, and after
 * `UNKNOWN_TOOL_STREAK_LIMIT` such steps in a row the turn stopped.
 *
 * That is a model mistake the agent already handled, not a defect of
 * the agent, so error reporting leaves it out (ATO-1674), as it does a
 * provider plan's own limit (ATO-1283). The person still sees the
 * failed turn; the trace and the `call names a tool this agent does not
 * have` log line still record each step. Any other `ToolExecutionError`
 * still reports.
 */
export function isUnregisteredToolStreak(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof ToolExecutionError && current.kind === "unregistered") return true;
    if (!(current instanceof Error)) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
