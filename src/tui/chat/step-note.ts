import { previewToolArgs } from "../render/tool-args-preview.js";
import type { ToolCardEntry } from "../tui-state.js";

/**
 * Verbose step notes (ATO-34): one plain line per finished tool call,
 * saying which step it was, what the agent called and with what, and
 * what came back. Built only from the tool card the reducer already
 * keeps; nothing here reads the trace or changes it.
 *
 * Per-call token cost is not on the card (the loop reports tokens per
 * model call, not per tool call), so the note does not claim one: the
 * duration is on the card header and `/why` prints the last model
 * call's tokens.
 */

const NOTE_ARGS_LIMIT = 72;

/** `1.2k chars` / `340 chars`: the size of what the tool handed back. */
export function resultSizeLabel(summary: string): string {
  const n = summary.length;
  if (n === 0) return "nothing back";
  if (n < 1000) return `${n} chars back`;
  return `${(n / 1000).toFixed(1)}k chars back`;
}

/** The call's args on one short line, or `no args`. */
export function stepArgsLabel(
  args: Record<string, unknown>,
  limit: number = NOTE_ARGS_LIMIT,
): string {
  const preview = previewToolArgs(args, limit);
  return preview.length > 0 ? preview : "no args";
}

/**
 * `step 3 · called os.fs.read path="a.ts" · ok, 1.2k chars back`.
 * Step numbers are 1-based, as `/status` counts them.
 */
export function stepNoteLine(
  card: Pick<
    ToolCardEntry,
    "stepIndex" | "tool" | "args" | "status" | "summary" | "truncated"
  >,
): string {
  const outcome =
    card.status === "ok" ? "ok" : card.status === "error" ? "failed" : "running";
  const size =
    card.status === "pending" ? "" : `, ${resultSizeLabel(card.summary)}`;
  const truncated = card.truncated ? " (truncated)" : "";
  return `step ${card.stepIndex + 1} · called ${card.tool} ${stepArgsLabel(card.args)} · ${outcome}${size}${truncated}`;
}
