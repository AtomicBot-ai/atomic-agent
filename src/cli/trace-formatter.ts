import type { TraceEvent } from "../tracing/index.js";

export interface FormatShowOptions {
  step?: number;
  raw?: boolean;
}

/**
 * Convert a trace event stream into a compact human-readable chronology
 * suitable for `atomic-agent trace show`. Long payloads (prompt tail,
 * completion content) are truncated unless `raw` is set — the full
 * bytes live in the NDJSON file and can be inspected with `trace
 * export` anyway.
 */
export function formatTraceChronology(
  events: readonly TraceEvent[],
  options: FormatShowOptions = {},
): string {
  const lines: string[] = [];
  for (const event of events) {
    if (options.step !== undefined) {
      const stepIndex = extractStepIndex(event);
      if (stepIndex !== options.step) continue;
    }
    lines.push(formatTraceEvent(event, options.raw === true));
  }
  return lines.join("\n");
}

/**
 * Return the event's `stepIndex` or `null` for session/turn-level
 * events. The `trace show --step N` filter treats `null` as "does not
 * match": only events tied to a specific step survive, so the caller
 * sees a focused view of that step.
 */
function extractStepIndex(event: TraceEvent): number | null {
  if ("stepIndex" in event && typeof event.stepIndex === "number") {
    return event.stepIndex;
  }
  return null;
}

function formatTraceEvent(event: TraceEvent, raw: boolean): string {
  const ts = new Date(event.ts).toISOString();
  const head = `[${ts}] #${event.seq} ${event.type}`;
  switch (event.type) {
    case "session_started":
      return `${head} workingDir=${event.workingDir}`;
    case "turn_started":
      return `${head} turn=${event.turnIndex}${
        event.userMessage ? ` user=${truncate(event.userMessage, 80, raw)}` : ""
      }`;
    case "turn_finished":
      return `${head} turn=${event.turnIndex} reason=${event.reason} steps=${event.stepCount} durationMs=${event.durationMs}`;
    case "step_started":
      return `${head} turn=${event.turnIndex} step=${event.stepIndex}`;
    case "step_finished":
      return `${head} turn=${event.turnIndex} step=${event.stepIndex} durationMs=${event.durationMs} summary=${truncate(event.summary, 160, raw)}`;
    case "prompt_captured":
      return `${head} step=${event.stepIndex} prefixHash=${event.stablePrefixHash.slice(0, 12)} tokens(total=${event.tokens.total},prefix=${event.tokens.stablePrefix},tail=${event.tokens.tail}) cacheReused=${event.cacheReused}${
        raw ? `\n  tail: ${event.tail}` : ""
      }`;
    case "llm_completion": {
      const timing = event.timing
        ? ` promptMs=${event.timing.promptMs} predictedMs=${event.timing.predictedMs} tokens(p=${event.timing.promptTokens},c=${event.timing.predictedTokens})`
        : "";
      return `${head} step=${event.stepIndex} attempt=${event.attempt} cacheHit=${event.cacheHitTokens}${timing}${
        raw
          ? `\n  content: ${event.content}${
              event.reasoningContent
                ? `\n  reasoning: ${event.reasoningContent}`
                : ""
            }`
          : ` content=${truncate(event.content, 160, false)}`
      }`;
    }
    case "tool_invocation":
      return `${head} step=${event.stepIndex} tool=${event.tool} status=${event.status} summary=${truncate(event.summary, 120, raw)}${
        raw ? `\n  args: ${JSON.stringify(event.args)}` : ""
      }`;
    case "parse_retry":
      return `${head} step=${event.stepIndex} attempt=${event.attempt} reason=${event.reason}`;
    case "loop_detected":
      return `${head} step=${event.stepIndex} tool=${event.tool} count=${event.count}${
        event.detector !== undefined ? ` detector=${event.detector}` : ""
      }${
        // Read-repeat lines are unreadable without the file and range the
        // detector was talking about; the fingerprints show that the
        // content did not move between the two reads.
        event.read !== undefined
          ? ` path=${event.read.path} lines=${event.read.startLine}-${event.read.endLine} fingerprint=${event.read.previousFingerprint}→${event.read.fingerprint}`
          : ""
      }`;
    case "error":
      return `${head} message=${event.message}`;
    case "trace_truncated":
      return `${head} reason=${event.reason}`;
    default:
      return `${head} ${JSON.stringify(event)}`;
  }
}

function truncate(input: string, max: number, raw: boolean): string {
  if (raw) return input;
  if (input.length <= max) return input;
  return `${input.slice(0, max)}… (+${input.length - max} chars)`;
}
