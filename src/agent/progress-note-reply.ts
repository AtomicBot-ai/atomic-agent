import type { ToolCallPayload } from "../llm/grammar/tool-call-grammar.js";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../compressor/result-compressor.js";
import type { SessionState } from "../session/session-state.js";
import { recordTurn } from "../session/session-state.js";
import { assistantReplyTurn } from "../session/conversation-turn.js";
import { resourceClassFor } from "./tool-resource-class.js";
import type { StepEvent } from "./step-events.js";

/**
 * A `reply` batched with work tools is a progress note, not the end of
 * the turn.
 *
 * Live, a model emitted `[os.shell.run, reply "(collecting file
 * contents…)"]`: the shell ran, the reply closed the turn, and nothing
 * was built. The text was plainly a note about what the step was doing,
 * not an answer. So when a batch carries `reply` AND at least one
 * non-terminal call — in any position, not only the tail — the reply is
 * taken out before validation, the rest runs, and the step loop
 * continues. The text is kept: a `reply` result with
 * `details.progressNote`, a flagged `assistant_reply` row in the
 * transcript, and the `assistant_reply` event marked `progressNote` so a
 * UI renders it as an interim message. The turn ends only on a sole
 * `reply` (a length-1 batch), or on the forced final step, where the
 * batch behaves exactly as before.
 *
 * `finish` batched with work keeps its behaviour (session end): out of
 * scope here. The model is told once per turn, on the standard
 * `### notice` channel, why the turn did not close.
 */

export interface ProgressNoteSplit {
  /** The batch with the note taken out, in emitted order. */
  calls: ToolCallPayload[];
  /** The `reply` that became the note. */
  note: ToolCallPayload;
}

/**
 * Take the progress note out of a batch, or `null` when the batch is
 * left as it is: a sole call, the forced final step, no `reply` with
 * text, or nothing but terminals around it (`[reply, reply]` stays for
 * the validator to reject).
 */
export function splitProgressNoteReply(
  calls: readonly ToolCallPayload[],
  options: { terminalOnly?: boolean } = {},
): ProgressNoteSplit | null {
  if (options.terminalOnly === true) return null;
  if (calls.length < 2) return null;
  const noteIdx = calls.findIndex(
    (call) => call.tool === "reply" && replyText(call) !== null,
  );
  if (noteIdx === -1) return null;
  const rest = calls.filter((_, i) => i !== noteIdx);
  if (!rest.some((call) => resourceClassFor(call.tool) !== "terminal")) {
    return null;
  }
  return { calls: rest, note: calls[noteIdx]! };
}

/** The note's text — the `reply` argument, which the split checked. */
export function progressNoteText(note: ToolCallPayload): string {
  return replyText(note) ?? "";
}

function replyText(call: ToolCallPayload): string | null {
  const text = call.args?.text;
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

/** What the note's `reply` result says in the feed and the trace. */
export const PROGRESS_NOTE_RESULT =
  "progress note recorded; the turn continues — reply ends the turn only when it is the sole call";

/**
 * The result standing in for the `reply` that did not run: `ok`, so the
 * transcript and the trace read the note as kept, not refused.
 */
export function progressNoteResult(): CompressedToolResult {
  return compressToolResult({
    tool: "reply",
    status: "ok",
    output: PROGRESS_NOTE_RESULT,
    details: { progressNote: true },
  });
}

export function isProgressNoteResult(result: CompressedToolResult): boolean {
  return result.tool === "reply" && result.details?.progressNote === true;
}

/** The `### notice` text the model reads on the step after a note. */
export function formatProgressNoteNotice(): string {
  return (
    "Your previous emission batched `reply` with other tool calls. The reply was " +
    "recorded as a progress note and the turn continued: reply ends the turn only " +
    "when it is the sole call. Keep working; when the task is done, emit `reply` " +
    "alone, as a length-1 array."
  );
}

/**
 * Per-turn "told once" state for the notice, held by the loop the way
 * the claim-evidence state is. Absent from a step's dependencies, the
 * notice is given on every note.
 */
export interface ProgressNoteNoticeState {
  noticed(): boolean;
  markNoticed(): void;
}

export function createProgressNoteNoticeState(): ProgressNoteNoticeState {
  let given = false;
  return {
    noticed: () => given,
    markNoticed: () => {
      given = true;
    },
  };
}

/**
 * The step summary for a note step: `progress note + N tools: …`, the
 * tools being the calls that actually ran.
 */
export function formatProgressNoteStepSummary(
  results: readonly CompressedToolResult[],
): string {
  const ran = results.filter((result) => !isProgressNoteResult(result));
  const list = ran.map((r) => `${r.tool}[${r.status}]`).join(", ");
  return `progress note + ${ran.length} tool${ran.length === 1 ? "" : "s"}: ${list}`;
}

export interface RecordProgressNoteParams {
  state: SessionState;
  note: ToolCallPayload;
  /** Position of the note in the step's events; the count includes it. */
  batchIndex: number;
  batchSize: number;
  onEvent?: (event: StepEvent) => void;
}

/**
 * Deliver the note after the work ran: its `tool_call_executed`, the
 * flagged `assistant_reply` row after the step's tool pairs, and the
 * `assistant_reply` event marked `progressNote` — the same message shape
 * a UI already renders, minus the end of the turn.
 */
export function recordProgressNote(params: RecordProgressNoteParams): {
  state: SessionState;
  result: CompressedToolResult;
} {
  const { state, note, batchIndex, batchSize, onEvent } = params;
  const result = progressNoteResult();
  onEvent?.({ type: "tool_call_executed", result, batchIndex, batchSize });
  const text = progressNoteText(note);
  onEvent?.({ type: "assistant_reply", text, progressNote: true });
  return {
    state: recordTurn(state, assistantReplyTurn(text, { progressNote: true })),
    result,
  };
}
