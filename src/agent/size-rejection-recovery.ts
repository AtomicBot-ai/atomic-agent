import type { ToolCallTransport } from "../llm/provider/completion-types.js";
import {
  isRequestSizeRejection,
  readContextLengthFromRejection,
  requestSizeRejectionNamesContext,
} from "../llm/reliability/request-size-rejection.js";

/**
 * How the agent loop recovers from a request the provider refused for
 * its size (a 400/413 naming the context length).
 *
 * A model without a catalog entry is assumed to have 128K; the first
 * step whose prompt outgrows the real window used to end the turn with
 * the provider's sentence and nothing else. The sentence usually names
 * the window ("maximum context length is 8192 tokens … you requested
 * 9134") — so the loop learns it, packs the next prompt to it through
 * the same learned-window path a mid-reply cut uses, and retries the
 * step once with a notice. When the body names no number, the window
 * is taken as `SIZE_REJECTION_SHRINK` of the prompt the loop just
 * estimated — enough to fit, and the catalogue is corrected the moment
 * the server proves the window larger.
 *
 * Native-tool providers only: a llama-server link reports its window
 * through `/props`, and its size 400 means the prompt was mis-sized
 * against a window the runtime already knows.
 */
export const SIZE_REJECTION_SHRINK = 0.8;

/** Below this a "window" is a parsing accident, not a context length. */
const MIN_PLAUSIBLE_WINDOW = 1_024;

export interface SizeRejectionRepack {
  /** The window to pack the retried prompt to. */
  contextWindow: number;
  /** Where the number came from. */
  source: "provider" | "estimate";
}

export interface PlanSizeRejectionRepackInput {
  /** The failure the step threw. Anything but a size rejection plans nothing. */
  error: unknown;
  /** This step index was already retried for size; a second refusal ends the turn. */
  alreadyRetried: boolean;
  /** The request was the loop's own raised-cap truncation retry — the cap, not the window, was refused. */
  raisedCapRefused: boolean;
  /** The transport of the link that refused. */
  transport: ToolCallTransport;
  /** The loop's estimate of the refused prompt, in tokens; `0` when unknown. */
  promptTokens: number;
  /** The window the runtime believes in, when it knows one. */
  contextWindow: number | null;
  /** Whether a learned window has anywhere to go (`onContextWindowObserved` wired). */
  canFitWindow: boolean;
}

export function planSizeRejectionRepack(
  input: PlanSizeRejectionRepackInput,
): SizeRejectionRepack | null {
  if (input.alreadyRetried || input.raisedCapRefused || !input.canFitWindow) {
    return null;
  }
  if (input.transport !== "native_tools") return null;
  if (!isRequestSizeRejection(input.error)) return null;
  // A refusal that names only the reply cap ("max_tokens is too large
  // … supports at most 16384 completion tokens") is not a window
  // problem; a smaller prompt changes nothing about it.
  if (!requestSizeRejectionNamesContext(input.error)) return null;
  const believed = input.contextWindow;
  const named = readContextLengthFromRejection(input.error);
  if (
    named !== null &&
    named >= MIN_PLAUSIBLE_WINDOW &&
    (believed === null || named < believed)
  ) {
    return { contextWindow: named, source: "provider" };
  }
  const estimated = Math.floor(input.promptTokens * SIZE_REJECTION_SHRINK);
  if (estimated < MIN_PLAUSIBLE_WINDOW) return null;
  if (believed !== null && estimated >= believed) return null;
  return { contextWindow: estimated, source: "estimate" };
}

/** The `### notice` the retried step carries. */
export const SIZE_REJECTION_NOTICE =
  "The model server rejected the previous request as too large for its context window, so older conversation history was trimmed to fit this model's window. " +
  "Continue from the latest tool results, keep your reasoning brief, and emit the tool call now.";

/**
 * Fold the notice into whatever one-shot notice the step already
 * carries (loop detector, steering). Existing text first.
 */
export function composeSizeRejectionNotice(
  existing: string | undefined,
): string {
  if (existing === undefined || existing.length === 0) {
    return SIZE_REJECTION_NOTICE;
  }
  return `${existing}\n\n${SIZE_REJECTION_NOTICE}`;
}
