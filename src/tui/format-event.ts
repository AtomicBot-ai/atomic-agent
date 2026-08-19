/**
 * Pure formatters that turn discrete agent events into single-line,
 * display-ready strings. Kept separate from the reducer so both the TUI
 * and future non-interactive renderers can reuse them.
 */

export type FeedLineInput =
  | { type: "step_started"; stepIndex: number }
  | { type: "step_finished"; stepIndex: number; summary: string; durationMs: number }
  | {
      type: "prompt_captured";
      stepIndex: number;
      total: number;
      stablePrefix: number;
      tail: number;
      cacheReused: boolean;
    }
  | {
      type: "parse_retry";
      stepIndex: number;
      attempt: number;
      reason: string;
    }
  | {
      type: "tool_call_parsed";
      tool: string;
      args: Record<string, unknown>;
      batchIndex?: number;
      batchSize?: number;
    }
  | {
      type: "tool_call_executed";
      tool: string;
      status: "ok" | "error";
      summary: string;
      truncated: boolean;
      batchIndex?: number;
      batchSize?: number;
    }
  | {
      type: "rare_tool_autoloaded";
      tool: string;
    }
  | {
      type: "step_routed";
      stepIndex: number;
      role: "orchestrator" | "executor";
      providerId: string;
      complexity: number;
      cloudShare: number;
    };

const ARGS_PREVIEW_LIMIT = 160;
const SUMMARY_PREVIEW_LIMIT = 240;

export function formatFeedLine(input: FeedLineInput): string {
  switch (input.type) {
    case "step_started":
      return `[step ${input.stepIndex}] started`;
    case "step_finished":
      return `[step ${input.stepIndex}] ${clip(input.summary, SUMMARY_PREVIEW_LIMIT)} (${input.durationMs}ms)`;
    case "prompt_captured": {
      const cache = input.cacheReused ? "cache hit" : "cache miss";
      return `[step ${input.stepIndex}] prompt ${input.total} tok (${input.stablePrefix} prefix, ${input.tail} tail, ${cache})`;
    }
    case "parse_retry":
      return `[step ${input.stepIndex}] repair retry ${input.attempt}: ${clip(input.reason, SUMMARY_PREVIEW_LIMIT)}`;
    case "tool_call_parsed":
      return `  → ${formatBatch(input)}${input.tool}(${clip(safeStringify(input.args), ARGS_PREVIEW_LIMIT)})`;
    case "tool_call_executed": {
      const suffix = input.truncated ? " (truncated)" : "";
      return `  ← ${formatBatch(input)}${input.tool} ${input.status}: ${clip(input.summary, SUMMARY_PREVIEW_LIMIT)}${suffix}`;
    }
    case "rare_tool_autoloaded": {
      return `  ↻ loaded schema for ${input.tool} after tool error`;
    }
    case "step_routed": {
      // Show the cutoff alongside the score so the line explains the
      // decision rather than just announcing it.
      const cutoff = 100 - input.cloudShare;
      const leg =
        input.role === "orchestrator" ? "cloud orchestrator" : "local executor";
      const comparison = input.role === "orchestrator" ? "≥" : "<";
      return `[step ${input.stepIndex}] → ${leg} ${input.providerId} (complexity ${input.complexity} ${comparison} ${cutoff})`;
    }
    default:
      return "";
  }
}

function formatBatch(input: { batchIndex?: number; batchSize?: number }): string {
  if (!input.batchSize || input.batchSize <= 1) return "";
  const index = input.batchIndex ?? 0;
  return `[${index + 1}/${input.batchSize}] `;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserialisable]";
  }
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}
