import type { StepContext, StepDependencies } from "./step-contract.js";
import type { ToolCallBatch } from "../../llm/grammar/tool-call-grammar.js";
import { ToolExecutionError } from "../../llm/index.js";
import { resolveToolName } from "../tool-name-resolution.js";
import { logTextPreview } from "./step-parsing.js";
import {
  UNKNOWN_TOOL_STREAK_LIMIT,
  closestToolNames,
  unregisteredToolNameClass,
} from "../policies/unknown-tool.js";

/** Longest unregistered name one log line keeps. */
const LOG_TOOL_CHARS = 80;

/**
 * The batch with every call that names a registered tool in another
 * spelling (`functions.reply`, `mcp_github_create_issue`) renamed to the
 * registered name, before anything reads the names.
 *
 * Resolution used to happen at admission (`step-evidence.ts`), after
 * the step's checks had already read the raw name: `functions.reply`
 * was no `reply` to the fabricated-transcript, claim and link holds or
 * to the progress-note split, and a gated tool spelled another way was
 * no gated tool to the batch trim, yet it ran as one (ATO-1674). The
 * step's policy calls this first, so every check sees the tool that
 * runs. A name that does not resolve is left as written for the
 * unknown-tool result. Calls are copied, never changed in place.
 */
export function resolveBatchToolNames(
  ctx: StepContext,
  deps: Pick<StepDependencies, "registry" | "logger">,
  batch: ToolCallBatch,
): ToolCallBatch {
  let changed = false;
  const calls = batch.calls.map((call) => {
    if (deps.registry.has(call.tool)) return call;
    const resolved = resolveToolName(call.tool, deps.registry);
    if (resolved === null || resolved === call.tool) return call;
    changed = true;
    deps.logger?.debug?.("tool name resolved to its registered form", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      emitted: logTextPreview(call.tool, LOG_TOOL_CHARS),
      resolved,
    });
    return { ...call, tool: resolved };
  });
  return changed ? { ...batch, calls } : batch;
}

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
