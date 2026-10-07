import type { StepContext } from "./step-contract.js";
import { LlmFailure, classifyFailure, CancelledError, LlamaServerError, TransportError, GrammarError, OpenAiHttpError, isRequestSizeRejection, humanizeOpenAiHttpError, ToolExecutionError } from "../../llm/index.js";
import { ToolCallParseError } from "../../llm/grammar/tool-call-grammar.js";


/** Validation failure for a multi-call batch (forbidden tool / oversized / unknown). */
export class BatchValidationError extends Error {
  constructor(
    message: string,
    /** Per-call error reason, indexed by `batchIndex`. `null` ⇒ this call was fine. */
    public readonly perCall: Array<string | null>,
  ) {
    super(message);
    this.name = "BatchValidationError";
  }
}


/**
 * Normalise any thrown value into an `LlmFailure` so the `step_error`
 * event always carries a canonical `category`. Values that already
 * implement the failure contract short-circuit; raw `LlamaServerError`,
 * `ToolCallParseError`, abort signals and plain errors get wrapped.
 */
export function toLlmFailure(err: unknown, ctx: StepContext): LlmFailure {
  if (err instanceof LlmFailure) return err;
  // A stopped step's request that fails the way requests fail (an abort,
  // a torn socket, a cut-off body) is the stop's doing. An error the
  // classifier does not recognise — `tool`, the shape a programming error
  // arrives in — stays what it is whatever the signal says, so it is
  // reported as a failure, not filed away as a cancel (ATO-137).
  if (ctx.signal.aborted && classifyFailure(err) !== "tool") {
    return new CancelledError(
      err instanceof Error ? err.message : "operation cancelled",
      { cause: err },
    );
  }
  if (err instanceof LlamaServerError) {
    // Delegate the status split to `classifyFailure` rather than
    // restating it. This arm used to carry its own hardcoded copy
    // (`status === null || >= 500` ⇒ transport, everything else ⇒
    // grammar), and because `executeStep` rethrows *this* wrapper — and
    // `classifyFailure`'s first line short-circuits on `LlmFailure` —
    // the copy, not the classifier, decided the category the user reads.
    // The two diverged the moment the taxonomy moved: a 404 from a wrong
    // `localModels.url` still surfaced as `Turn failed [grammar]` with no
    // unreachable hint. One taxonomy, one place.
    //
    // `classifyFailure` cannot return `cancelled`/`model`/`tool` for a
    // `LlamaServerError` (its own arm returns only `transport` or
    // `grammar`, and it is reached before the abort/network branches),
    // and an aborted step has already been claimed by the
    // `ctx.signal.aborted` check above — so nothing is laundered here.
    // Only `transport` becomes a `TransportError`; every other answer
    // keeps the historical `GrammarError`.
    if (classifyFailure(err) === "transport") {
      return new TransportError(err.message, err.status, err.url, {
        cause: err,
      });
    }
    return new GrammarError(err.message, "", { cause: err });
  }
  // Cloud provider failures — any status — are provider-boundary
  // problems, not tool bugs. A 429 or a dead key must never read as
  // `Turn failed [tool]`. The HTTP client has already spent its bounded
  // retry budget on the transient subset by the time this propagates.
  // The chat message gets the human wording; the raw technical string
  // stays on the cause for logs.
  if (err instanceof OpenAiHttpError) {
    // A request the provider refused for its size is the one 400 whose
    // body the user needs to read: it names the limit. Everything else
    // keeps the humanized line alone.
    const message = isRequestSizeRejection(err)
      ? `${humanizeOpenAiHttpError(err)} ${requestSizeExcerpt(err.message)}`
      : humanizeOpenAiHttpError(err);
    return new TransportError(message, err.status, err.url, {
      cause: err,
    });
  }
  if (err instanceof ToolCallParseError) {
    return new GrammarError(err.message, "", { cause: err });
  }
  if (isAbortError(err)) {
    return new CancelledError(
      err instanceof Error ? err.message : "operation cancelled",
      { cause: err },
    );
  }
  const wrapped = err instanceof Error ? err : new Error(String(err));
  const categorised = classifyFailure(wrapped);
  if (categorised === "cancelled") {
    return new CancelledError(wrapped.message, { cause: err });
  }
  // A raw socket failure from a surface that does not wrap its own
  // errors (MCP streamable-http, embeddings, a vendor SDK carrying its
  // own `fetch`) reaches here as a bare `TypeError: fetch failed`. It is
  // a provider-boundary problem, not a tool bug: wrapping it as
  // `ToolExecutionError("unknown", …)` both mislabels the turn for the
  // user and blocks the fallback chain from advancing.
  if (categorised === "transport") {
    return new TransportError(wrapped.message, null, "", { cause: err });
  }
  return new ToolExecutionError("unknown", wrapped.message, { cause: err });
}


/** The provider's own sentence about the limit, without the status prefix. */
export function requestSizeExcerpt(message: string): string {
  const body = message.replace(/^openai provider \d+:\s*/, "").trim();
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}


export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError";
}
