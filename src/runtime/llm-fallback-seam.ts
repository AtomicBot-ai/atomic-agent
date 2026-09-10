import type { LlmStreamParams } from "../agent/step-executor.js";
import type {
  CompletionResult,
  StreamChunk,
  ToolCallTransport,
} from "../llm/provider/completion-types.js";
import { replayPrimedStream, runWithFallback } from "../llm/fallback/index.js";
import type { ProviderFallbackChain } from "../llm/fallback/index.js";
import {
  completeOnLink,
  openStreamOnLink,
  type LinkAttemptDeps,
} from "./llm-link-attempt.js";

export type { ResolvedLinkSlice } from "./llm-link-attempt.js";

/**
 * Dependencies the fallback seams need, injected so the seam is testable
 * without the whole bootstrap. Everything that stays bootstrap's concern
 * (cost accumulator, turn-usage meter, model pricing) is folded in
 * through the two `record*Usage` callbacks — the seam only owns the
 * fallback loop and the `servedTransport` stamp.
 */
export interface FallbackSeamDeps extends LinkAttemptDeps {
  fallbackChain: ProviderFallbackChain;
  /**
   * Awaited once per attempt, before the completion is sent, with the
   * link the chain picked. Exists for the state a link may need warmed
   * before it can serve: a `llama-server` link reached by fallover from
   * a cloud primary boots with its `/health` + `/props` probes deferred
   * (issue #112), and this is the last point at which they can still
   * run. Kept as a hook rather than folded into `resolveSlice` because
   * that seam is synchronous, and rather than into the attempt body
   * because only bootstrap knows what "warm" means for a link kind.
   *
   * Must not throw for a reachable link: a rejection here fails the
   * attempt and advances the chain, same as a failed completion.
   *
   * The `providerId` says WHICH link is about to serve, not where it
   * lives. Bootstrap's implementation warms the one local backend the
   * runtime owns — the `ModelProfileManager` built over the shared
   * `LlamaServerClient`, which reads `localModels.url` per request — so
   * a second `llama-server` entry pointed at a different host is
   * announced here but warmed against the configured URL. That is a
   * pre-existing `ModelProfileManager` limitation (it is a singleton
   * over one client, not a per-link cache), not something this hook
   * introduces; multi-endpoint local links would need a manager per
   * link before it could mean anything more.
   */
  prepareLink?: (providerId: string) => Promise<void>;
  /**
   * Fold a unary completion's usage into cost + meter (no-op when
   * absent). `providerId` is the link that actually served — the chain's
   * pick, or the pin — so pricing is looked up against the provider the
   * tokens were spent on, not the active one.
   */
  recordUnaryUsage: (
    params: LlmStreamParams,
    result: CompletionResult,
    providerId: string,
  ) => void;
  /** Fold a streamed completion's usage into the meter (same `providerId` contract). */
  recordStreamUsage: (
    sessionId: string | undefined,
    result: CompletionResult,
    providerId: string,
  ) => void;
}

/**
 * Build the unary `llmComplete` seam: route the request through the
 * cross-provider fallback chain (each attempt resolves the transport for
 * THAT link), fold usage, and **stamp `servedTransport`** with the
 * transport of the link that actually answered — so the caller parses the
 * reply with the served provider's transport, not the primary's (they can
 * differ on a cloud→local fallover). See AGENTS.md §"Provider fallback
 * chain" → "Cross-transport fallover".
 *
 * **A pinned request never falls over.** When `params.providerId` is
 * set, the single attempt runs directly against that provider and
 * `runWithFallback` is never entered. The pin exists to spend local
 * tokens (a fusion worker on the local leg); falling over would silently
 * run the worker on the cloud leg and invert the cost model the mode was
 * chosen for. A pinned failure is rethrown as-is — the orchestrator is
 * the retry authority, and the chain's breaker state stays untouched by
 * a link it did not pick.
 */
export function createFallbackCompleter(
  deps: FallbackSeamDeps,
): (params: LlmStreamParams) => Promise<CompletionResult> {
  const attempt = async (
    providerId: string,
    params: LlmStreamParams,
  ): Promise<CompletionResult> => {
    const { result, transport } = await completeOnLink(
      deps,
      params,
      providerId,
    );
    deps.recordUnaryUsage(params, result, providerId);
    return { ...result, servedTransport: transport };
  };
  return async (params) =>
    params.providerId !== undefined
      ? attempt(params.providerId, params)
      : runWithFallback(
          deps.fallbackChain,
          (providerId) => attempt(providerId, params),
          params.sessionId,
        );
}

/**
 * Build the streaming `llmCompleteStream` seam. The first chunk is primed
 * inside the fallback attempt so a failure to OPEN the stream (429/5xx
 * before any output) advances the chain, while a live stream is never
 * restarted. The served link's transport is stamped on the return value,
 * same contract as the unary seam — and on EVERY chunk, because the
 * return value only exists once the stream finishes: the step executor's
 * live stream parser must know the serving transport up front to
 * classify grammar-served reasoning (which starts mid-`<think>`) as
 * reasoning deltas during a cross-transport fallover.
 *
 * A pinned request (`params.providerId`) opens the stream directly on
 * that link and never enters the chain — same rationale as the unary
 * seam.
 */
export function createFallbackStreamer(
  deps: FallbackSeamDeps,
): (
  params: LlmStreamParams,
) => AsyncGenerator<StreamChunk, CompletionResult, void> {
  return (params) => {
    async function* run(): AsyncGenerator<StreamChunk, CompletionResult, void> {
      const opened =
        params.providerId !== undefined
          ? {
              providerId: params.providerId,
              ...(await openStreamOnLink(deps, params, params.providerId)),
            }
          : await runWithFallback(
              deps.fallbackChain,
              async (id) => ({
                providerId: id,
                ...(await openStreamOnLink(deps, params, id)),
              }),
              params.sessionId,
            );
      const { primed, transport, providerId } = opened;
      const result = yield* stampServedTransport(
        replayPrimedStream(primed),
        transport,
      );
      deps.recordStreamUsage(params.sessionId, result, providerId);
      return { ...result, servedTransport: transport };
    }
    return run();
  };
}

/**
 * Stamp the serving link's transport on every chunk (see the
 * `StreamChunk.servedTransport` contract — the final result's stamp
 * arrives too late for live consumers to reconfigure their parser on a
 * cross-transport fallover).
 *
 * Usage is folded by the caller once this returns: the stream's *return*
 * value carries `usage` (deltas do not), so totals only exist once the
 * generator finishes; an abandoned stream never returns and contributes
 * nothing (a cancelled turn reports only what it finished accounting
 * for).
 */
async function* stampServedTransport(
  stream: AsyncGenerator<StreamChunk, CompletionResult, void>,
  transport: ToolCallTransport,
): AsyncGenerator<StreamChunk, CompletionResult, void> {
  let next = await stream.next();
  while (!next.done) {
    yield { ...next.value, servedTransport: transport };
    next = await stream.next();
  }
  return next.value;
}
