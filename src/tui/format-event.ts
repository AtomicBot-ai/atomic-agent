/**
 * Pure formatters that turn discrete agent events into single-line,
 * display-ready strings. Kept separate from the reducer so both the TUI
 * and future non-interactive renderers can reuse them.
 */

export type FeedLineInput =
  | { type: "step_started"; stepIndex: number }
  | { type: "step_finished"; stepIndex: number; summary: string; durationMs: number }
  | { type: "tool_call_parsed"; tool: string; args: Record<string, unknown> }
  | {
      type: "tool_call_executed";
      tool: string;
      status: "ok" | "error";
      summary: string;
      truncated: boolean;
    };

const ARGS_PREVIEW_LIMIT = 160;
const SUMMARY_PREVIEW_LIMIT = 240;

export function formatFeedLine(input: FeedLineInput): string {
  switch (input.type) {
    case "step_started":
      return `[step ${input.stepIndex}] started`;
    case "step_finished":
      return `[step ${input.stepIndex}] ${clip(input.summary, SUMMARY_PREVIEW_LIMIT)} (${input.durationMs}ms)`;
    case "tool_call_parsed":
      return `  → ${input.tool}(${clip(safeStringify(input.args), ARGS_PREVIEW_LIMIT)})`;
    case "tool_call_executed": {
      const suffix = input.truncated ? " (truncated)" : "";
      return `  ← ${input.tool} ${input.status}: ${clip(input.summary, SUMMARY_PREVIEW_LIMIT)}${suffix}`;
    }
    default:
      return "";
  }
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
