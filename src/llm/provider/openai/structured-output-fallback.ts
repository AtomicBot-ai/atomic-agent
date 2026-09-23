import type { CompletionRequest } from "../completion-types.js";
import { isStructuredOutputRefusal } from "./structured-output-refusal.js";

/** Minimal logging surface this fallback needs (satisfied by `StructuredLogger`). */
export interface StructuredOutputLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * The (provider id, model) pairs whose endpoint refused structured
 * outputs, for the lifetime of the process.
 *
 * Kept out of the provider instance on purpose: a provider is rebuilt on
 * hot-swap and on every config write, and forgetting the refusal there
 * would put the failed round trip back on every sub-call after each
 * save. Not persisted either — a vendor that ships `json_schema` support
 * is picked up on the next start, which is the cheapest re-probe there is.
 */
export class StructuredOutputRefusals {
  private readonly pairs = new Set<string>();

  has(providerId: string, model: string): boolean {
    return this.pairs.has(pairKey(providerId, model));
  }

  /** Record a pair; `true` only the first time, which is when to log. */
  record(providerId: string, model: string): boolean {
    const key = pairKey(providerId, model);
    if (this.pairs.has(key)) return false;
    this.pairs.add(key);
    return true;
  }
}

/** The process-wide record every `OpenAiProvider` consults. */
export const structuredOutputRefusals = new StructuredOutputRefusals();

function pairKey(providerId: string, model: string): string {
  return JSON.stringify([providerId, model]);
}

export interface StructuredOutputFallbackContext {
  providerId: string;
  model: string;
  logger?: StructuredOutputLogger | undefined;
  /** Defaults to the process-wide record; injected by tests. */
  refusals?: StructuredOutputRefusals;
}

/**
 * Send a unary completion, and when its endpoint refuses the
 * `response_format` the request carried, send it once more without it.
 *
 * Why this is safe: `response_format` is only set by the memory
 * sub-runners (query rewriter, link generator, vote runner, distill), and
 * every one of their prompts still asks for its text format — the
 * `<rewritten_query>` envelope, `LINK` / `UPVOTE` / `LESSON` lines — which
 * their parsers read whenever the reply is not JSON. Losing the schema
 * costs decode enforcement, not the answer.
 *
 * Why it lives here, below the fallback chain: every cloud
 * `OpenAiHttpError` classifies as `transport`, so an unhandled refusal
 * advanced `runWithFallback` to the next link — for a sub-call whose
 * request was the only thing wrong — and did so again on every sub-call.
 * Handled inside the provider's `complete`, the chain never sees it.
 *
 * Bounded: exactly one extra send, not wrapped again. The refusal is
 * remembered only once that send is accepted, which is what proves the
 * field was the problem; a retry that fails too propagates its own error
 * and leaves the provider untouched. Afterwards the pair skips
 * `response_format` up front, with no failed round trip.
 *
 * Only a request where dropping `responseFormat` changes the wire takes
 * this path: a request that also carries `tools` never sends
 * `response_format` (`buildOpenAiChatBody`), and one set through
 * `extraBody` is the operator's and is never removed.
 */
export async function sendWithStructuredOutputFallback<T>(
  ctx: StructuredOutputFallbackContext,
  request: CompletionRequest,
  buildBody: (request: CompletionRequest) => Record<string, unknown>,
  send: (body: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const body = buildBody(request);
  if (!request.responseFormat) return send(body);
  const promptOnly: CompletionRequest = { ...request };
  delete promptOnly.responseFormat;
  const promptOnlyBody = buildBody(promptOnly);
  if (promptOnlyBody.response_format === body.response_format) {
    return send(body);
  }
  const refusals = ctx.refusals ?? structuredOutputRefusals;
  if (refusals.has(ctx.providerId, ctx.model)) return send(promptOnlyBody);
  try {
    return await send(body);
  } catch (err) {
    if (request.signal?.aborted || !isStructuredOutputRefusal(err)) throw err;
    const result = await send(promptOnlyBody);
    if (refusals.record(ctx.providerId, ctx.model)) {
      ctx.logger?.warn(structuredOutputFallbackMessage(ctx), {
        provider: ctx.providerId,
        model: ctx.model,
        status: err.status,
      });
    }
    return result;
  }
}

export function structuredOutputFallbackMessage(
  ctx: Pick<StructuredOutputFallbackContext, "providerId" | "model">,
): string {
  return (
    `llm: "${ctx.providerId}" does not support structured outputs ` +
    `(response_format) for ${ctx.model}; memory sub-calls fall back to ` +
    `prompt-only output for the rest of this run.`
  );
}
