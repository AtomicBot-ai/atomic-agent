/**
 * Recovery from a completion the runtime could not turn into tool calls.
 *
 * The step executor already gives such a completion one in-step repair:
 * the same request replayed with a `### tool-call-repair` block and a
 * hard `REPAIR_MAX_TOKENS` cap. That cap is the point — it stops a
 * reasoning model burning its whole budget re-deliberating — but it also
 * means a repair that has to re-emit a large argument (a file body on
 * `os.fs.write`) cannot fit, so the repair truncates and the step ends
 * as `GrammarError`.
 *
 * Today that ends the turn: the loop records `lastError`, the surfaces
 * print `Turn failed [grammar]: …`, and nothing else happens until the
 * operator notices the silence and types "try again". This module lets
 * the loop spend one or two ordinary steps instead — a fresh prompt at
 * the full completion budget, with a `### notice` saying what was
 * rejected. Same seam the loop detector and mid-turn steering use.
 *
 * Only a body OUR parser rejected qualifies. A `GrammarError` that wraps
 * a llama-server 4xx is the server refusing the request itself; another
 * inference reproduces it exactly.
 */

import { GrammarError, LlamaServerError, ToolCallParseError } from "../llm/index.js";

/**
 * Recoveries allowed per turn. Two, not one: the first is usually enough
 * for a transient serialization slip, and a model that needs a second is
 * often one that split an oversized write after being told to. A third
 * is a model that cannot emit valid JSON at all — spending the whole leg
 * proving it just delays the failure the operator has to read anyway.
 */
export const PARSE_RECOVERY_BUDGET = 2;

/**
 * Cap on the rejection reason quoted into the notice. Parser messages
 * are short by construction, but `JSON.parse` failures on V8 quote a
 * slice of the offending text, and that slice is model output whose
 * length we do not control.
 */
const MAX_REASON_CHARS = 300;

/**
 * Is this failure a completion body the runtime could not parse into
 * tool calls — as opposed to the model server rejecting the request?
 */
export function isRecoverableParseFailure(err: unknown): boolean {
  if (err instanceof ToolCallParseError) return true;
  if (!(err instanceof GrammarError)) return false;
  // `toLlmFailure` files a llama-server 400/413/422 as `GrammarError`
  // too: the server is telling us THIS request was malformed or too
  // large. Re-prompting cannot change that, and the turn should fail
  // with the diagnosis instead of burning two more steps.
  return !(err.cause instanceof LlamaServerError);
}

/**
 * The `### notice` block for the step that follows a rejected
 * completion. Says what was rejected, that nothing ran, and what to do
 * differently — including the one fix that actually resolves the common
 * case, which is an argument too large to re-emit in one call.
 */
export function formatParseFailureNotice(reason: string): string {
  return [
    `Your previous output was rejected before any tool ran: ${clip(reason)}`,
    "Nothing you attempted has happened yet — no file was written, no command ran.",
    "Emit the call again. Every tool call's arguments must be one valid JSON object, complete and correctly escaped.",
    "If the arguments were large (a long file body, a big patch), that is the likely cause: split the work into several smaller calls instead of one oversized one.",
  ].join("\n");
}

/**
 * Fold the notice into whatever the step already owed the model. The
 * loop detector and `composeSteerNotice` share this slot, and the
 * rejection comes first: it explains why the step is being taken again
 * at all, which is context for the instruction that follows.
 */
export function composeParseFailureNotice(
  existing: string | undefined,
  reason: string,
): string {
  const block = formatParseFailureNotice(reason);
  if (existing === undefined || existing.length === 0) return block;
  return `${block}\n\n${existing}`;
}

/**
 * The transcript row a failed turn leaves behind.
 *
 * Recorded, never emitted as an `assistant_reply` event: every surface
 * already prints its own `Turn failed [...]` line from `loop_failed`,
 * and a second copy would arrive as a message from the agent. What the
 * row is for is the NEXT turn — without it the model is asked to "try
 * again" with a transcript in which its own attempt simply never
 * happened, and it repeats the mistake verbatim.
 */
export function formatTurnFailedRecord(
  category: string,
  message: string,
): string {
  return `(this turn failed before it could answer — ${category}: ${clip(message)}. Nothing from it took effect.)`;
}

function clip(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  if (flat.length <= MAX_REASON_CHARS) return flat;
  return `${[...flat].slice(0, MAX_REASON_CHARS).join("")}…`;
}
