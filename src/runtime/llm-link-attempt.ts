import type { LlmStreamParams } from "../agent/step-executor.js";
import type {
  CompletionResult,
  StreamChunk,
  ToolCallTransport,
} from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import { primeStream, type PrimedStream } from "../llm/fallback/index.js";

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
 * What one attempt needs from the seam: the link resolver plus the
 * optional warm-up hook. Kept as a subset of `FallbackSeamDeps` so the
 * attempt body is shared between the chain-picked path and the pinned
 * path without either knowing about the other.
 */
export interface LinkAttemptDeps {
  resolveSlice: (providerId: string) => ResolvedLinkSlice;
  prepareLink?: (providerId: string) => Promise<void>;
}

/**
 * Prompt text for the link that is about to serve this attempt. The main
 * `prompt` is built for the PRIMARY's transport; when the primary is
 * native-tools and the profile needs a reasoning prefill, the prompt was
 * built prefill-suppressed (issue #283) — but a grammar (llama-server)
 * link still expects the legacy prefill-carrying shape (its template and
 * GBNF prelude assume the open tag is pre-typed at the generation
 * point). `grammarPrompt` is the lazy variant the step executor provides
 * for exactly that fallover; absent (grammar primary, plain profile) the
 * shared prompt is already the right shape for the link.
 */
function promptFor(
  params: LlmStreamParams,
  transport: ToolCallTransport,
): string {
  return transport === "native_tools"
    ? params.prompt
    : params.grammarPrompt?.() ?? params.prompt;
}

function nativeRequestFields(params: LlmStreamParams) {
  return {
    ...(params.tools ? { tools: params.tools } : {}),
    ...(params.toolChoice !== undefined ? { toolChoice: params.toolChoice } : {}),
    ...(params.parallelToolCalls !== undefined
      ? { parallelToolCalls: params.parallelToolCalls }
      : {}),
  };
}

function grammarRequestFields(params: LlmStreamParams) {
  return {
    grammar: params.grammar,
    slotId: params.slotId,
    cachePrompt: params.slotId >= 0,
  };
}

/**
 * One unary attempt against `providerId`: warm the link, resolve its
 * transport, send the request in that transport's shape. Returns the
 * raw result plus the transport that served it; the caller stamps
 * `servedTransport` and folds usage.
 */
export async function completeOnLink(
  deps: LinkAttemptDeps,
  params: LlmStreamParams,
  providerId: string,
): Promise<{ result: CompletionResult; transport: ToolCallTransport }> {
  await deps.prepareLink?.(providerId);
  const { provider, transport } = deps.resolveSlice(providerId);
  const base = {
    prompt: promptFor(params, transport),
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
          ...nativeRequestFields(params),
          // Cloud sub-runners forward a `responseFormat` JSON-Schema
          // envelope; the main agent loop never sets it (it uses
          // `tools`), so this branch is a no-op there.
          ...(params.responseFormat
            ? { responseFormat: params.responseFormat }
            : {}),
        })
      : await provider.complete({ ...base, ...grammarRequestFields(params) });
  return { result, transport };
}

/**
 * One streaming attempt against `providerId`, primed to its first chunk
 * so a failure to OPEN the stream surfaces here (and can advance the
 * chain) while a live stream is never restarted.
 */
export async function openStreamOnLink(
  deps: LinkAttemptDeps,
  params: LlmStreamParams,
  providerId: string,
): Promise<{
  primed: PrimedStream<StreamChunk, CompletionResult>;
  transport: ToolCallTransport;
}> {
  await deps.prepareLink?.(providerId);
  const { provider, transport } = deps.resolveSlice(providerId);
  const base = {
    prompt: promptFor(params, transport),
    sessionId: params.sessionId,
    ...(params.signal ? { signal: params.signal } : {}),
  };
  const stream =
    transport === "native_tools"
      ? provider.completeStream({ ...base, ...nativeRequestFields(params) })
      : provider.completeStream({ ...base, ...grammarRequestFields(params) });
  return { primed: await primeStream(stream), transport };
}
