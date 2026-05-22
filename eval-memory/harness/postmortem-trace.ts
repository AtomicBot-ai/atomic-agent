/**
 * Pure trace-analyzer for "empty replies tail" postmortems.
 *
 * Reads the append-only trace ndjson produced by the runtime
 * (`<stateDir>/traces/<sessionId>.ndjson`, see `src/tracing/trace/`)
 * and returns a structured report grouping `turn_finished` events by
 * `reason`, plus per-turn step counts, latencies, prompt-token
 * trajectory, and the last few `error` events. This is the
 * read-side counterpart of `diagnostics-writer.ts`: that helper
 * captures the subprocess-level outcome; this one zooms in on the
 * runtime's internal step-by-step behaviour for a single child.
 *
 * The module is pure (no I/O, no `Date.now()`) so it can be tested
 * against a synthetic fixture. The CLI wrapper in
 * `eval-memory/scripts/locomo-postmortem.ts` is the only I/O-bound
 * caller.
 */

import type { TraceEvent } from "../../src/tracing/trace/trace-event.js";

export interface TurnSummary {
  turnIndex: number;
  /**
   * `null` when no `turn_finished` event was recorded for this turn
   * (e.g. the subprocess was killed mid-step). Differentiates a
   * clean terminal verb from a hard cancellation.
   */
  reason: string | null;
  stepCount: number;
  durationMs: number;
  /** Sum of `prompt_captured.tokens.total` across the turn's steps. */
  totalPromptTokens: number;
  /** Max single-step `prompt_captured.tokens.total`. Heavy-tail signal. */
  maxPromptTokens: number;
  /** Count of `error` events recorded against this turn. */
  errorCount: number;
  /**
   * Last three `error` events for this turn, in chronological order.
   * `category` is the canonical LLM failure taxonomy tag when present.
   * Empty when no errors were recorded.
   */
  lastErrors: ReadonlyArray<{ message: string; category: string | null }>;
  /** First `assistant_reply` text, if the runtime emitted one. */
  assistantReply: string | null;
  /** `userMessage` payload from `turn_started`, when present. */
  userMessage: string | null;
}

export interface PostmortemReport {
  sessionId: string | null;
  totalTurns: number;
  /** Count of turns grouped by `reason`. `null` reasons fold to `<no-finish>`. */
  reasonHistogram: Readonly<Record<string, number>>;
  /**
   * Per-turn rollups in `turnIndex` order. Always populated for every
   * `turn_started` event observed, even when no `turn_finished` was
   * recorded (`reason: null`).
   */
  turns: readonly TurnSummary[];
  /**
   * Subset of `turns` where `reason !== "reply"` AND `reason !== "finish"`.
   * The set the user reads first during postmortem — these are the
   * turns that contributed empty replies to the conversation.
   */
  problemTurns: readonly TurnSummary[];
  /**
   * Last `trace_truncated` event if any was recorded, indicating the
   * trace hit `tracing.trace.maxBytesPerSession` and subsequent
   * events were dropped — important caveat for postmortems on long
   * runs.
   */
  traceTruncated: { reason: string; atSeq: number } | null;
}

/**
 * Build the postmortem report from a sequential list of trace events.
 * Events are assumed to be in `seq` order (the natural NDJSON-read
 * order); the function does not re-sort them.
 */
export function analyzeTrace(events: readonly TraceEvent[]): PostmortemReport {
  const turnIndexes = new Set<number>();
  const turnState = new Map<
    number,
    {
      reason: string | null;
      stepCount: number;
      durationMs: number;
      totalPromptTokens: number;
      maxPromptTokens: number;
      errorCount: number;
      lastErrors: { message: string; category: string | null }[];
      assistantReply: string | null;
      userMessage: string | null;
    }
  >();
  let sessionId: string | null = null;
  let traceTruncated: { reason: string; atSeq: number } | null = null;

  const ensureTurn = (turnIndex: number) => {
    let entry = turnState.get(turnIndex);
    if (!entry) {
      entry = {
        reason: null,
        stepCount: 0,
        durationMs: 0,
        totalPromptTokens: 0,
        maxPromptTokens: 0,
        errorCount: 0,
        lastErrors: [],
        assistantReply: null,
        userMessage: null,
      };
      turnState.set(turnIndex, entry);
      turnIndexes.add(turnIndex);
    }
    return entry;
  };

  for (const ev of events) {
    if (!sessionId && (ev as { sessionId?: string }).sessionId) {
      sessionId = (ev as { sessionId: string }).sessionId;
    }
    switch (ev.type) {
      case "turn_started": {
        const t = ensureTurn(ev.turnIndex);
        t.userMessage = ev.userMessage ?? t.userMessage;
        break;
      }
      case "turn_finished": {
        const t = ensureTurn(ev.turnIndex);
        t.reason = ev.reason;
        t.stepCount = ev.stepCount;
        t.durationMs = ev.durationMs;
        break;
      }
      case "prompt_captured": {
        const t = ensureTurn(ev.turnIndex);
        const total = ev.tokens.total;
        t.totalPromptTokens += total;
        if (total > t.maxPromptTokens) t.maxPromptTokens = total;
        break;
      }
      case "error": {
        if (typeof ev.turnIndex === "number") {
          const t = ensureTurn(ev.turnIndex);
          t.errorCount += 1;
          t.lastErrors.push({
            message: ev.message,
            category: ev.category ?? null,
          });
          // Keep at most 3 most recent — trim from the head.
          if (t.lastErrors.length > 3) {
            t.lastErrors.splice(0, t.lastErrors.length - 3);
          }
        }
        break;
      }
      case "trace_truncated": {
        traceTruncated = { reason: ev.reason, atSeq: ev.seq };
        break;
      }
      default:
        break;
    }
  }

  // Note: assistant_reply text is not in the TraceEvent union directly
  // (it is an AgentLoopEvent forwarded by the loop). The trace
  // captures it indirectly through `llm_completion.content` but that
  // includes intermediate tool-call payloads. We leave `assistantReply`
  // as `null` here — `diagnostics-writer.ts` already captures the final
  // reply at the question level; this analyzer is for in-process
  // diagnostics of why turns ended in non-reply reasons.

  const reasonHistogram: Record<string, number> = {};
  const turns: TurnSummary[] = [];
  const sortedIndexes = Array.from(turnIndexes).sort((a, b) => a - b);
  for (const idx of sortedIndexes) {
    const state = turnState.get(idx)!;
    const key = state.reason ?? "<no-finish>";
    reasonHistogram[key] = (reasonHistogram[key] ?? 0) + 1;
    turns.push({
      turnIndex: idx,
      reason: state.reason,
      stepCount: state.stepCount,
      durationMs: state.durationMs,
      totalPromptTokens: state.totalPromptTokens,
      maxPromptTokens: state.maxPromptTokens,
      errorCount: state.errorCount,
      lastErrors: [...state.lastErrors],
      assistantReply: state.assistantReply,
      userMessage: state.userMessage,
    });
  }

  const problemTurns = turns.filter(
    (t) => t.reason !== "reply" && t.reason !== "finish",
  );

  return {
    sessionId,
    totalTurns: turns.length,
    reasonHistogram,
    turns,
    problemTurns,
    traceTruncated,
  };
}

/**
 * Render the postmortem report as a human-readable markdown string.
 * Pure; the CLI wrapper feeds the result to stdout or a file.
 */
export function renderPostmortem(report: PostmortemReport): string {
  const lines: string[] = [];
  lines.push(`# Trace postmortem`);
  lines.push("");
  lines.push(`- Session: ${report.sessionId ?? "(unknown)"}`);
  lines.push(`- Total turns: ${report.totalTurns}`);
  if (report.traceTruncated) {
    lines.push(
      `- ⚠ Trace truncated at seq=${report.traceTruncated.atSeq} (reason: ${report.traceTruncated.reason})`,
    );
  }
  lines.push("");
  lines.push("## Reason histogram");
  lines.push("");
  const keys = Object.keys(report.reasonHistogram).sort();
  if (keys.length === 0) {
    lines.push("(no turns recorded)");
  } else {
    lines.push("| reason | count |");
    lines.push("|---|---|");
    for (const k of keys) lines.push(`| ${k} | ${report.reasonHistogram[k]} |`);
  }
  lines.push("");
  lines.push(`## Problem turns (reason ≠ reply / finish): ${report.problemTurns.length}`);
  lines.push("");
  if (report.problemTurns.length === 0) {
    lines.push("(none)");
  } else {
    lines.push("| turnIndex | reason | steps | durationMs | maxPromptTokens | errorCount |");
    lines.push("|---|---|---|---|---|---|");
    for (const t of report.problemTurns) {
      lines.push(
        `| ${t.turnIndex} | ${t.reason ?? "<no-finish>"} | ${t.stepCount} | ${t.durationMs} | ${t.maxPromptTokens} | ${t.errorCount} |`,
      );
    }
    lines.push("");
    lines.push("## Error details for problem turns");
    lines.push("");
    for (const t of report.problemTurns) {
      if (t.errorCount === 0) continue;
      lines.push(`### Turn #${t.turnIndex} (${t.reason ?? "<no-finish>"})`);
      for (const e of t.lastErrors) {
        const cat = e.category ?? "-";
        lines.push(`- [${cat}] ${e.message}`);
      }
      lines.push("");
    }
  }
  lines.push("## Prompt-token trajectory");
  lines.push("");
  lines.push("Per-turn max prompt tokens (first 50, then last 20):");
  lines.push("");
  const tokens = report.turns.map((t) => t.maxPromptTokens);
  lines.push("| turnIndex | reason | maxPromptTokens |");
  lines.push("|---|---|---|");
  const head = report.turns.slice(0, 50);
  const tail = report.turns.slice(-20);
  const seen = new Set<number>();
  for (const t of [...head, ...tail]) {
    if (seen.has(t.turnIndex)) continue;
    seen.add(t.turnIndex);
    lines.push(`| ${t.turnIndex} | ${t.reason ?? "<no-finish>"} | ${t.maxPromptTokens} |`);
  }
  if (tokens.length > 0) {
    const max = Math.max(...tokens);
    const final = tokens[tokens.length - 1];
    const first = tokens[0];
    lines.push("");
    lines.push(`Range: first=${first}, last=${final}, max=${max}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Parse an ndjson string into a typed event array. Lines that fail
 * `JSON.parse` are skipped (logged via the optional `onSkip` callback)
 * — postmortem must remain best-effort even when the file was truncated
 * by SIGKILL mid-line.
 */
export function parseTraceNdjson(
  raw: string,
  onSkip?: (line: string, error: Error) => void,
): TraceEvent[] {
  const out: TraceEvent[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as TraceEvent);
    } catch (err) {
      onSkip?.(trimmed, err as Error);
    }
  }
  return out;
}
