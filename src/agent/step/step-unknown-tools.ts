import type { StepContext, StepDependencies } from "./step-contract.js";
import { ToolExecutionError } from "../../llm/index.js";
import { logTextPreview } from "./step-parsing.js";
import {
  UNKNOWN_TOOL_STREAK_LIMIT,
  closestToolNames,
  unregisteredToolNameClass,
} from "../policies/unknown-tool.js";

/** Longest unregistered name one log line keeps. */
const LOG_TOOL_CHARS = 80;

/**
 * Admission for the calls of a step that name no registered tool (after
 * `resolveToolName`). They stay in the batch: the scheduler answers each
 * with an error result naming the closest real tools
 * (`refuseUnregisteredTool`), and the step's valid calls run as usual.
 *
 * The bound: a step whose every call is unregistered extends the turn's
 * streak (`deps.unknownTools`); any other step resets it. On the
 * {@link UNKNOWN_TOOL_STREAK_LIMIT}th such step in a row this throws the
 * `ToolExecutionError` the step always threw, marked
 * `kind: "unregistered"` so error reports group it as one issue. With no
 * streak state wired (a caller outside the agent loop) an unknown-only
 * step throws at once, as before.
 */
export function admitUnregisteredCalls(
  ctx: StepContext,
  deps: StepDependencies,
  callCount: number,
  unregistered: readonly string[],
): void {
  const unknownOnly = callCount > 0 && unregistered.length === callCount;
  const streak =
    deps.unknownTools?.record(unknownOnly) ??
    (unknownOnly ? UNKNOWN_TOOL_STREAK_LIMIT : 0);
  if (unregistered.length === 0) return;
  deps.logger?.warn("call names a tool this agent does not have", {
    sessionId: ctx.session.id,
    stepIndex: ctx.stepIndex,
    tools: unregistered.map((tool) => logTextPreview(tool, LOG_TOOL_CHARS)),
    unknownOnly,
    streak,
  });
  if (!unknownOnly || streak < UNKNOWN_TOOL_STREAK_LIMIT) return;
  const tool = unregistered[0]!;
  const suggestions = closestToolNames(
    tool,
    deps.registry.list().map((definition) => definition.name),
  );
  throw new ToolExecutionError(
    tool,
    `tool not registered in this agent: ${tool}`,
    { kind: "unregistered", nameClass: unregisteredToolNameClass(tool, suggestions) },
  );
}
