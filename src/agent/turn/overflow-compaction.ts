import {
  readContextLengthFromRejection,
  readServerContextCounts,
} from "../../llm/reliability/request-size-rejection.js";
import { contextCompactionRejection } from "./compaction-recovery.js";
import { SIZE_REJECTION_SHRINK } from "./size-rejection-recovery.js";

/**
 * How the agent loop recovers when the model server refuses a step's
 * request as too large for its context window (llama.cpp
 * `exceed_context_size_error`, an OpenAI-style "maximum context length"
 * 400/413): compact the conversation once, retry the same step, and —
 * if that is not enough — end the turn with a plain sentence instead of
 * the server's.
 *
 * A refused inference has executed no tools, so the retry replays
 * nothing. One attempt per turn: a second refusal, or a compaction that
 * could not free room, ends the turn (no loop).
 *
 * The window the compaction plans against is the best evidence at hand,
 * in the agent's own token-estimate units (that is what the prompt
 * budget counts in):
 *  - `server_count`: llama.cpp's body named its window (`n_ctx`) AND
 *    counted the refused prompt (`n_prompt_tokens`) above the agent's
 *    estimate — the estimate undercounted this conversation, so the
 *    window is scaled by estimate / server count. Planning against the
 *    raw `n_ctx` would compact to a history that still does not fit.
 *  - `provider`: the body or message named the window.
 *  - `estimate`: nothing named — most of the refused prompt's estimate,
 *    the same rule `planSizeRejectionRepack` uses.
 *  - `believed`: no number at all; the step's own window stands.
 */
export type OverflowWindowSource = "server_count" | "provider" | "estimate" | "believed";

export interface PlanOverflowCompactionInput {
  /** What the step threw. Anything but a context-size refusal plans nothing. */
  error: unknown;
  /** This turn already spent its one overflow compaction. */
  attempted: boolean;
  /** The turn's request deadline or signal already fired. */
  aborted: boolean;
  /** A compaction control and a prompt input to compact are wired. */
  canCompact: boolean;
  /** The agent's estimate of the refused prompt, in tokens; `0` when unknown. */
  promptTokens: number;
  /** The window the refused prompt was packed to, when known. */
  believedWindow: number | null;
}

export interface OverflowCompactionPlan {
  /** The size rejection found on the error's cause chain. */
  rejection: unknown;
  /** Window (estimate units) to plan the compaction against; null keeps the step's own. */
  compactionWindow: number | null;
  /**
   * A window worth remembering for later prompts (real tokens: the
   * server's own or most of the estimate); null when nothing new was
   * learned. Never the `server_count` scaled figure, which is in the
   * agent's estimate units.
   */
  learnedWindow: number | null;
  source: OverflowWindowSource;
  /** `n_ctx` / named window of the server, when it said one. */
  serverWindow: number | null;
  /** `n_prompt_tokens` the server counted, when it said. */
  serverPromptTokens: number | null;
}

/** Below this a "window" is a parsing accident, not a context length. */
const MIN_PLAUSIBLE_WINDOW = 512;

export function planOverflowCompaction(
  input: PlanOverflowCompactionInput,
): OverflowCompactionPlan | null {
  if (input.attempted || input.aborted || !input.canCompact) return null;
  const rejection = contextCompactionRejection(input.error);
  if (rejection === null) return null;
  const named = readContextLengthFromRejection(rejection);
  const serverWindow = named !== null && named >= MIN_PLAUSIBLE_WINDOW ? named : null;
  const serverPromptTokens = readServerContextCounts(rejection).promptTokens ?? null;
  const estimate = input.promptTokens > 0 ? input.promptTokens : 0;
  const believed = input.believedWindow;
  const shrinks = (window: number): boolean => believed === null || window < believed;

  if (serverWindow !== null) {
    const learnedWindow = shrinks(serverWindow) ? serverWindow : null;
    if (serverPromptTokens !== null && estimate > 0 && serverPromptTokens > estimate) {
      const scaled = Math.floor((serverWindow * estimate) / serverPromptTokens);
      if (scaled >= MIN_PLAUSIBLE_WINDOW) {
        return { rejection, compactionWindow: scaled, learnedWindow, source: "server_count", serverWindow, serverPromptTokens };
      }
    }
    return {
      rejection,
      // A window no smaller than the step's own adds nothing: the step's
      // packed prompt already planned against it.
      compactionWindow: shrinks(serverWindow) ? serverWindow : null,
      learnedWindow,
      source: shrinks(serverWindow) ? "provider" : "believed",
      serverWindow,
      serverPromptTokens,
    };
  }
  const estimated = Math.floor(estimate * SIZE_REJECTION_SHRINK);
  if (estimated >= MIN_PLAUSIBLE_WINDOW && shrinks(estimated)) {
    return { rejection, compactionWindow: estimated, learnedWindow: estimated, source: "estimate", serverWindow: null, serverPromptTokens };
  }
  return { rejection, compactionWindow: null, learnedWindow: null, source: "believed", serverWindow: null, serverPromptTokens };
}

/**
 * The turn's terminal error when the conversation still does not fit
 * after the one overflow compaction (or none could free room). Plain
 * words with the two ways out; the server's own sentence stays on
 * `cause` for logs and error reporting.
 */
export class ContextWindowExhaustedError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message);
    this.name = "ContextWindowExhaustedError";
    (this as { cause?: unknown }).cause = options.cause;
  }
}

export function contextWindowExhaustedError(input: {
  cause: unknown;
  /** Whether a compaction ran for this refusal before the turn gave up. */
  compacted: boolean;
}): ContextWindowExhaustedError {
  const named = readContextLengthFromRejection(input.cause);
  const window =
    named !== null && named >= MIN_PLAUSIBLE_WINDOW
      ? `this model's context window (${named.toLocaleString("en-US")} tokens)`
      : "this model's context window";
  const after = input.compacted
    ? "even after older history was compacted"
    : "and older history could not be compacted to make room";
  return new ContextWindowExhaustedError(
    `The conversation no longer fits ${window}, ${after}. ` +
      "Start a new session, or load the model with a larger context size.",
    { cause: input.cause },
  );
}
