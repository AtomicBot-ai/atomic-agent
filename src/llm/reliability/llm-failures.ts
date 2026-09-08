import type { ToolCallTransport } from "../provider/completion-types.js";
import type {
  LlmFailureCategory,
  ModelFailureReason,
  ModelFailureStage,
} from "./failure-category.js";

export interface LlmFailureOptions {
  cause?: unknown;
}

/**
 * `ModelError` extras.
 *
 * `transport` is the *effective* tool-call transport that the defective
 * completion was parsed under — the transport of the link that actually
 * served it, not necessarily the configured one (see `parseDepsFor` in
 * `src/agent/step-executor.ts`).
 *
 * `stage` says which attempt inside the step raised the defect, which is
 * the axis `transport` does **not** cover: within one transport the
 * first-attempt throw and the repair-also-came-back-empty throw are
 * otherwise indistinguishable.
 */
export interface ModelErrorOptions extends LlmFailureOptions {
  transport?: ToolCallTransport;
  stage?: ModelFailureStage;
}

/**
 * Base class for every runtime failure that needs to travel through the
 * agent loop's observability surface (events, traces, metrics, TUI).
 * Subclasses pin `category` so `instanceof LlmFailure` plus the discriminated
 * field alone are enough for downstream consumers — no extra classifier
 * step is required once an error has reached this shape.
 */
export abstract class LlmFailure extends Error {
  abstract readonly category: LlmFailureCategory;

  constructor(message: string, options?: LlmFailureOptions) {
    super(message);
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Transport-layer failure: network error reaching llama-server, HTTP 5xx,
 * or a timeout from the AbortController on the outbound request. Retries
 * live inside `LlamaServerClient`; by the time a `TransportError`
 * propagates to the step executor, the bounded budget is exhausted.
 */
export class TransportError extends LlmFailure {
  readonly category = "transport" as const;

  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
    options?: LlmFailureOptions,
  ) {
    super(message, options);
    this.name = "TransportError";
  }
}

/**
 * Grammar / validation failure: either llama-server returned a 4xx
 * (grammar rejected, request malformed) or the completion body could
 * not be parsed into a valid tool call even after the one-shot parser
 * retry. Carries a short preview of the raw output so postmortems can
 * tell grammar misconfiguration apart from model drift without replaying
 * the stream.
 */
export class GrammarError extends LlmFailure {
  readonly category = "grammar" as const;

  constructor(
    message: string,
    readonly rawPreview: string,
    options?: LlmFailureOptions,
  ) {
    super(message, options);
    this.name = "GrammarError";
  }
}

/**
 * Model-side defect in the completion itself (truncation, empty output,
 * missing stop token). These are never retried in-place because the
 * model already consumed its budget on this prompt — a second pass over
 * the same prefix would almost certainly hit the same wall.
 *
 * `reason` alone is ambiguous for the largest of these buckets, and two
 * orthogonal facts are needed to disambiguate it:
 *
 *  - `transport` — which tool-call transport the completion was parsed
 *    under. `empty` on `native_tools` and `empty` on a grammar link are
 *    produced by different rule sets
 *    (`isNativeToolsEmptyCompletionHandledByParser` vs
 *    `isGrammarEmptyCompletionWorthRepairing`).
 *  - `stage` — which attempt raised it. On `native_tools` an `empty`
 *    completion with nothing in any channel ends the step at `initial`
 *    by design, while a `content`-empty completion that still carries
 *    `reasoning_content` survives that check, fails the parse, goes
 *    through the one-shot repair, and raises the *same*
 *    `reason=empty` + `transport=native_tools` pair at `repair` when the
 *    repair is empty too. Without `stage` those two are one bucket.
 *
 * Both are diagnostic only — nothing branches on either.
 */
export class ModelError extends LlmFailure {
  readonly category = "model" as const;

  /** Effective transport the defective completion was parsed under. */
  readonly transport?: ToolCallTransport;

  /** Which attempt inside the step raised this defect. */
  readonly stage?: ModelFailureStage;

  constructor(
    readonly reason: ModelFailureReason,
    message: string,
    options?: ModelErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelError";
    if (options?.transport !== undefined) {
      this.transport = options.transport;
    }
    if (options?.stage !== undefined) {
      this.stage = options.stage;
    }
  }
}

/**
 * Tool-side failure that escaped the tool's own error handling. The
 * registry's `invoke` folds most tool runtime errors into a
 * `CompressedToolResult { status: "error" }`, so this class mainly
 * captures "tool not registered" and aborts rethrown from a running
 * tool when `ctx.signal.aborted` is false.
 */
export class ToolExecutionError extends LlmFailure {
  readonly category = "tool" as const;

  constructor(
    readonly tool: string,
    message: string,
    options?: LlmFailureOptions,
  ) {
    super(message, options);
    this.name = "ToolExecutionError";
  }
}

/**
 * User- or host-driven cancellation. Distinguished from `ToolExecutionError`
 * so dashboards do not count aborts as failures and retry policies can
 * short-circuit without a second attempt.
 */
export class CancelledError extends LlmFailure {
  readonly category = "cancelled" as const;

  constructor(message = "operation cancelled", options?: LlmFailureOptions) {
    super(message, options);
    this.name = "CancelledError";
  }
}
