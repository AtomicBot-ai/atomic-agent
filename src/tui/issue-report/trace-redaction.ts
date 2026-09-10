/**
 * Per-line filtering of a session's NDJSON trace by privacy level.
 *
 * A trace mixes two kinds of rows. Structural ones (`step_started`,
 * `turn_finished`, `provider_waiting`, timings, token counts) are what
 * a maintainer needs to see the shape of a failure and carry nothing
 * the operator wrote. Content ones (`prompt_captured.tail`,
 * `llm_completion.content`, `tool_invocation.args` / `summary` /
 * `details`, the memory-fabric events) are the operator's session.
 * The level decides what happens to the second kind.
 */

import type { IssueReportLevel } from "./report-levels.js";
import {
  mapStrings,
  maskSecrets,
  redactPaths,
  scrubText,
  type RedactionContext,
} from "./redact.js";

/** Fields that carry operator content, per event type. */
const CONTENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  prompt_captured: ["tail"],
  llm_completion: ["content", "reasoningContent"],
  tool_invocation: ["args", "summary", "details"],
  session_started: ["workingDir", "metadata"],
  // The user's message opens a turn; the first tool result's summary
  // closes a step. Both are the operator's session, not its shape.
  turn_started: ["userMessage"],
  step_finished: ["summary"],
  // A repair reason quotes what the model emitted.
  parse_retry: ["reason"],
  loop_detected: ["read"],
};

/** Event types that are content through and through (memory fabric). */
const CONTENT_ONLY_EVENTS: ReadonlySet<string> = new Set([
  "reflection",
  "distill",
  "query_rewriter",
  "link_generator",
  "procedure_created",
  "vote_applied",
  "vote_rejected",
  "lesson_deprecated",
  "procedure_deprecated",
]);

export interface TraceRedactionStats {
  kept: number;
  dropped: number;
  stripped: number;
}

/**
 * Filter one trace file's text. Returns the new NDJSON and what
 * happened to each row — the counts land in the report so the reader
 * knows the trace is a projection, not the original.
 *
 * - `full`: every row, strings passed through `maskSecrets`.
 * - `scrubbed`: content-only events dropped; content fields on mixed
 *   events replaced by `"<removed>"`; every remaining string scrubbed.
 * - `errors`: only `error`, `loop_detected`, `provider_waiting`,
 *   `provider_recovered`, `trace_truncated`, `turn_finished` and
 *   `step_finished` rows, scrubbed.
 */
export function redactTraceNdjson(
  ndjson: string,
  level: IssueReportLevel,
  ctx: RedactionContext,
): { text: string; stats: TraceRedactionStats } {
  const stats: TraceRedactionStats = { kept: 0, dropped: 0, stripped: 0 };
  const scrub = (s: string): string =>
    level === "full"
      ? maskSecrets(s)
      : level === "errors"
        ? redactPaths(scrubText(s, ctx))
        : scrubText(s, ctx);
  const out: string[] = [];
  for (const line of ndjson.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null) {
        stats.dropped += 1;
        continue;
      }
      event = parsed as Record<string, unknown>;
    } catch {
      // An unparsable row is treated as content: we cannot tell.
      stats.dropped += 1;
      continue;
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (level === "errors" && !ERROR_LEVEL_EVENTS.has(type)) {
      stats.dropped += 1;
      continue;
    }
    if (level !== "full") {
      // A session id is a join key to the operator's other files;
      // the zip names traces by ordinal instead.
      delete event.sessionId;
      if (CONTENT_ONLY_EVENTS.has(type)) {
        stats.dropped += 1;
        continue;
      }
      const fields = CONTENT_FIELDS[type];
      if (fields) {
        for (const field of fields) {
          if (field in event) {
            event[field] = "<removed>";
            stats.stripped += 1;
          }
        }
      }
    }
    out.push(JSON.stringify(mapStrings(event, scrub)));
    stats.kept += 1;
  }
  return { text: out.length > 0 ? `${out.join("\n")}\n` : "", stats };
}

const ERROR_LEVEL_EVENTS: ReadonlySet<string> = new Set([
  "error",
  "loop_detected",
  "provider_waiting",
  "provider_recovered",
  "trace_truncated",
  "turn_finished",
  "step_finished",
  "parse_retry",
  "task_continued",
]);
