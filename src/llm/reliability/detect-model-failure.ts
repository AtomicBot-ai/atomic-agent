import type { CompletionResult } from "../llama-server-client.js";
import type {
  ModelFailureReason,
  ModelFailureStage,
  TruncationCause,
  TruncationDetail,
} from "./failure-category.js";

export interface DetectedModelFailure {
  reason: ModelFailureReason;
  message: string;
  /** Present only when `reason === "truncated"`. */
  truncation?: TruncationDetail;
}

export interface DetectModelFailureOptions {
  /**
   * The `max_tokens` / `n_predict` cap the request carried. Without it a
   * truncated reply cannot be told apart from a full context window, so
   * the message can only say "truncated".
   */
  requestedMaxTokens?: number;
  /**
   * Which attempt produced the completion. The repair pass runs under
   * its own cap, and the message names that instead of the config key.
   */
  stage?: ModelFailureStage;
  /**
   * The context window the runtime believes in (catalogue or learned),
   * when it knows one. A reply cut short of the cap with prompt + reply
   * well inside this window is the provider's output limit, not the
   * window — and must not be learned as one.
   */
  contextWindow?: number | null;
}

/**
 * Inspect a completion for model-side defects that make a retry on the
 * same prompt pointless:
 *
 *  - `truncated`: the server cut the reply off — either the reply cap
 *    the request carried (`max_tokens` / `n_predict`) ran out, or the
 *    server's context window filled up mid-generation. Re-running the
 *    same prompt under the same cap just reproduces the wall; the agent
 *    loop retries with a *different* request (see `truncation`).
 *  - `empty`:     neither `content` nor `reasoningContent` carry usable
 *    text. Most often a misrouted grammar or a model that stopped
 *    immediately after the first token.
 *  - `no_stop`:   the stream ended without the model emitting a stop
 *    token, while the body is still non-empty. Treated as soft evidence
 *    of a cut-off response. Only reported when the content does not
 *    already look like a complete JSON object, to avoid false positives
 *    on fully-parseable outputs that happened to race with stream close.
 *
 * Returns `null` when the completion looks healthy enough to hand off to
 * the grammar parser.
 */
export function detectModelFailure(
  completion: CompletionResult,
  options: DetectModelFailureOptions = {},
): DetectedModelFailure | null {
  if (completion.truncated) {
    const truncation = classifyTruncation(
      completion,
      options.requestedMaxTokens,
      options.contextWindow ?? null,
    );
    return {
      reason: "truncated",
      message: formatTruncatedMessage(truncation, options.stage),
      truncation,
    };
  }
  // The grammar parser runs over `content` only — `reasoningContent` is a
  // CoT sidechannel. A model that thought but never produced a tool-call
  // body counts as empty from the runtime's perspective.
  const trimmedContent = completion.content.trim();
  if (trimmedContent.length === 0) {
    return {
      reason: "empty",
      message: "model returned empty content",
    };
  }
  if (!completion.stop && !looksLikeClosedJsonObject(trimmedContent)) {
    return {
      reason: "no_stop",
      message:
        "model stream ended without a stop token and output is incomplete",
    };
  }
  return null;
}

/**
 * A reply that stopped this close to the cap spent the cap. Servers
 * count the cap in decoded tokens and some stop one short of it
 * (llama.cpp checks `n_decoded >= n_predict` after the stop-token
 * test), and a proxy's tokenizer may disagree by a token or two.
 */
const REPLY_CAP_SLACK_TOKENS = 16;

/**
 * Prompt + reply this far under a known window is not the window: the
 * provider clamped the reply at its own output limit for the model.
 */
const WINDOW_FILL_RATIO = 0.9;

/**
 * Which wall a truncated completion hit, decided from the provider's
 * usage block against the cap the request carried.
 *
 * The walls all arrive as the same `finish_reason: "length"`, and they
 * want different remedies: a reply that spent the whole cap needs a
 * bigger cap; a reply that stopped short of it ran into the server's
 * context window and needs a *smaller prompt* (or a bigger window) —
 * unless the runtime knows the window and prompt + reply sit well
 * inside it, in which case the provider's own output limit for the
 * model is the wall and only a lower cap helps. A provider that reports
 * no usage leaves them indistinguishable.
 *
 * llama-server never sends `usage`, only `timings`, and its `truncated`
 * flag has one meaning — the context overflowed — so a timings-only
 * completion is the window whatever the count says.
 */
export function classifyTruncation(
  completion: CompletionResult,
  requestedMaxTokens?: number,
  contextWindow: number | null = null,
): TruncationDetail {
  const completionTokens =
    completion.usage?.completionTokens ??
    completion.timing?.predictedTokens ??
    0;
  const promptTokens =
    completion.usage?.promptTokens ?? completion.timing?.promptTokens ?? 0;
  const requested = requestedMaxTokens ?? 0;
  let cause: TruncationCause = "unknown";
  if (completion.usage === undefined && completionTokens > 0) {
    cause = "context_window";
  } else if (completionTokens > 0 && requested > 0) {
    if (completionTokens + REPLY_CAP_SLACK_TOKENS >= requested) {
      cause = "reply_cap";
    } else if (
      contextWindow !== null &&
      contextWindow > 0 &&
      promptTokens + completionTokens < contextWindow * WINDOW_FILL_RATIO
    ) {
      cause = "output_limit";
    } else {
      cause = "context_window";
    }
  }
  return {
    cause,
    completionTokens,
    promptTokens,
    requestedMaxTokens: requested,
  };
}

/**
 * The sentence the user reads when a truncated reply ends the turn.
 * Names the wall and the knob — "model response truncated" on its own
 * sent people to change models, which cannot help either cause.
 */
export function formatTruncatedMessage(
  truncation: TruncationDetail,
  stage?: ModelFailureStage,
): string {
  const at =
    truncation.completionTokens > 0
      ? ` at ${truncation.completionTokens} tokens`
      : "";
  const capName =
    stage === "repair"
      ? "the repair pass's reply cap"
      : "the reply cap (localModels.completionMaxTokens)";
  switch (truncation.cause) {
    case "reply_cap":
      return (
        `model response truncated${at}: it spent ${capName} of ` +
        `${truncation.requestedMaxTokens} — raise it, or use a model that thinks less before answering`
      );
    case "context_window":
      return (
        `model response truncated${at}: the model server ran out of context ` +
        `after a ${truncation.promptTokens}-token prompt — start it with a larger ` +
        `context size, or start a new session`
      );
    case "output_limit":
      return (
        `model response truncated${at}: the provider stopped the reply below ${capName} ` +
        `of ${truncation.requestedMaxTokens} — this model's output limit is about ` +
        `${truncation.completionTokens} tokens; lower the cap to it, or pick another model`
      );
    default: {
      const walls =
        truncation.requestedMaxTokens > 0
          ? `the ${truncation.requestedMaxTokens}-token reply cap (localModels.completionMaxTokens) or the model server's context window`
          : "the reply cap (localModels.completionMaxTokens) or the model server's context window";
      return `model response truncated${at}: it hit ${walls}; the provider reported no token counts`;
    }
  }
}

/**
 * Cheap structural check — does the content look like it closed a JSON
 * object? Used only as a tie-breaker for `no_stop`: when the content
 * already ends with `}` the parser will either succeed or throw a
 * grammar error, which is the more useful signal.
 */
function looksLikeClosedJsonObject(text: string): boolean {
  if (text.length === 0) return false;
  const lastBrace = text.lastIndexOf("}");
  if (lastBrace === -1) return false;
  return lastBrace >= text.length - 3;
}
