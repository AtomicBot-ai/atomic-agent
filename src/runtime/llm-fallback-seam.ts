import type { LlmStreamParams } from "../agent/step-executor.js";
import type {
  CompletionResult,
  StreamChunk,
  ToolCallTransport,
} from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import {
  primeStream,
  replayPrimedStream,
  runWithFallback,
  type PrimedStream,
} from "../llm/fallback/index.js";
import type { ProviderFallbackChain } from "../llm/fallback/index.js";

/**
 * The `{ provider, transport }` slice for one chosen link. `bootstrap`
 * resolves this from `resolveActiveLlmSlice(providerId)` per attempt so a
 * fallover to a different provider gets that provider's wire transport.
 */
export interface ResolvedLinkSlice {
  provider: LlmProvider;
  transport: ToolCallTransport;
}

/**
 * Dependencies the fallback seams need, injected so the seam is testable
 * without the whole bootstrap. Everything that stays bootstrap's concern
 * (cost accumulator, turn-usage meter, model pricing) is folded in
 * through the two `record*Usage` callbacks — the seam only owns the
 * fallback loop and the `servedTransport` stamp.
 */
export interface FallbackSeamDeps {
  fallbackChain: ProviderFallbackChain;
  /** Resolve the served link's provider + transport for `providerId`. */
  resolveSlice: (providerId: string) => ResolvedLinkSlice;
  /** Fold a unary completion's usage into cost + meter (no-op when absent). */
  recordUnaryUsage: (params: LlmStreamParams, result: CompletionResult) => void;
  /** Fold a streamed completion's usage into the meter. */
  recordStreamUsage: (
    sessionId: string | undefined,
    result: CompletionResult,
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
 */
export function createFallbackCompleter(
  deps: FallbackSeamDeps,
): (params: LlmStreamParams) => Promise<CompletionResult> {
  return async (params) =>
    runWithFallback(
      deps.fallbackChain,
      async (providerId) => {
      const { provider, transport } = deps.resolveSlice(providerId);
      const base = {
        prompt: params.prompt,
        sessionId: params.sessionId,
        ...(typeof params.maxTokens === "number"
          ? { maxTokens: params.maxTokens }
          : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      };
      const result =
        transport === "native_tools"
          ? await provider.complete({
              ...base,
              ...(params.tools ? { tools: params.tools } : {}),
              ...(params.toolChoice !== undefined
                ? { toolChoice: params.toolChoice }
                : {}),
              ...(params.parallelToolCalls !== undefined
                ? { parallelToolCalls: params.parallelToolCalls }
                : {}),
              // Cloud sub-runners forward a `responseFormat` JSON-Schema
              // envelope; the main agent loop never sets it (it uses
              // `tools`), so this branch is a no-op there.
              ...(params.responseFormat
                ? { responseFormat: params.responseFormat }
                : {}),
            })
          : await provider.complete({
              ...base,
              grammar: params.grammar,
              slotId: params.slotId,
              cachePrompt: params.slotId >= 0,
            });
      deps.recordUnaryUsage(params, result);
      return { ...result, servedTransport: transport };
      },
      params.sessionId,
    );
}

/**
 * Build the streaming `llmCompleteStream` seam. The first chunk is primed
 * inside the fallback attempt so a failure to OPEN the stream (429/5xx
 * before any output) advances the chain, while a live stream is never
 * restarted. The served link's transport is stamped on the return value,
 * same contract as the unary seam.
 */
export function createFallbackStreamer(
  deps: FallbackSeamDeps,
): (
  params: LlmStreamParams,
) => AsyncGenerator<StreamChunk, CompletionResult, void> {
  const openStreamPrimed = async (
    providerId: string,
    params: LlmStreamParams,
  ): Promise<{
    primed: PrimedStream<StreamChunk, CompletionResult>;
    transport: ToolCallTransport;
  }> => {
    const { provider, transport } = deps.resolveSlice(providerId);
    const base = {
      prompt: params.prompt,
      sessionId: params.sessionId,
      ...(params.signal ? { signal: params.signal } : {}),
    };
    const stream =
      transport === "native_tools"
        ? provider.completeStream({
            ...base,
            ...(params.tools ? { tools: params.tools } : {}),
            ...(params.toolChoice !== undefined
              ? { toolChoice: params.toolChoice }
              : {}),
            ...(params.parallelToolCalls !== undefined
              ? { parallelToolCalls: params.parallelToolCalls }
              : {}),
          })
        : provider.completeStream({
            ...base,
            grammar: params.grammar,
            slotId: params.slotId,
            cachePrompt: params.slotId >= 0,
          });
    return { primed: await primeStream(stream), transport };
  };

  return (params) => {
    async function* run(): AsyncGenerator<StreamChunk, CompletionResult, void> {
      const { primed, transport } = await runWithFallback(
        deps.fallbackChain,
        (id) => openStreamPrimed(id, params),
        params.sessionId,
      );
      const result = yield* replayPrimedStream(primed);
      return { ...result, servedTransport: transport };
    }
    return meterStream(deps, params.sessionId, run());
  };
}

/**
 * Pass chunks through untouched and fold the final result's usage. The
 * stream's *return* value carries `usage` (deltas do not), so totals only
 * exist once the generator finishes; an abandoned stream never returns
 * and contributes nothing (a cancelled turn reports only what it
 * finished accounting for).
 */
async function* meterStream(
  deps: FallbackSeamDeps,
  sessionId: string | undefined,
  stream: AsyncGenerator<StreamChunk, CompletionResult, void>,
): AsyncGenerator<StreamChunk, CompletionResult, void> {
  const result = yield* stream;
  deps.recordStreamUsage(sessionId, result);
  return result;
}
