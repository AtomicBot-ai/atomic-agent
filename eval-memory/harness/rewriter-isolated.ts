/**
 * E9 — isolated query-rewriter harness against the managed
 * llama-server.
 *
 * Wraps `createQueryRewriterRunner` so each scenario case can:
 *   - run against a live LLM (default path — Phase A is a
 *     production runner, no need to mock it);
 *   - or override the LLM completion via `stubLlmComplete` for the
 *     few cases that need to exercise failure modes the live model
 *     does not naturally produce (malformed output).
 *
 * Mirrors the shape of `vote-isolated.ts`: no disk writes, no
 * `AgentMetrics` collector — the harness records each call's outcome
 * directly from `record()` callbacks injected via a fake metrics
 * surface.
 *
 * The runner always pins `slotId = -1` (load-bearing — see
 * `query-rewriter-runner.ts`); we surface the slot in the result so
 * the spec can assert on it.
 */

import {
  REWRITER_SLOT_ID,
  createQueryRewriterRunner,
  type QueryRewriterRunner,
  type RewriterHistoryTurn,
  type RewriterLlmComplete,
  type RewriterOutcome,
} from "../../src/memory/retrieve/index.js";
import type { CompletionResult } from "../../src/llm/llama-server-client.js";
import type { AgentMetrics } from "../../src/tracing/agent-metrics.js";

import type { LlmCompleteParams } from "./llm-client.js";

/**
 * Adapt the harness `llmComplete` (returns `LlmCompleteResult`) into
 * the runner's `RewriterLlmComplete` (returns `CompletionResult`).
 * The shape gap is tiny — we synthesise the missing fields.
 */
export function adaptHarnessLlmToRewriterComplete(
  harnessComplete: (params: LlmCompleteParams) => Promise<{
    content: string;
    reasoningContent: string;
    durationMs: number;
    promptTokens: number | null;
    predictedTokens: number | null;
  }>,
): RewriterLlmComplete {
  return async (params): Promise<CompletionResult> => {
    const harnessParams: LlmCompleteParams = {
      prompt: params.prompt,
      grammar: params.grammar,
      slotId: params.slotId,
      sessionId: params.sessionId,
      signal: params.signal,
      cachePrompt: false,
    };
    const result = await harnessComplete(harnessParams);
    return {
      content: result.content,
      reasoningContent: result.reasoningContent,
      timing: {
        promptMs: 0,
        predictedMs: result.durationMs,
        promptTokens: result.promptTokens ?? 0,
        predictedTokens: result.predictedTokens ?? 0,
      },
      cacheHitTokens: 0,
      slotId: params.slotId,
      modelId: null,
      stop: true,
      truncated: false,
    };
  };
}

/**
 * Stub `RewriterLlmComplete` for cases where the live model cannot
 * deterministically reproduce a failure mode (malformed parser
 * output, for example). The returned completion is treated like a
 * real one — the runner runs its parser + outcome recording over it.
 */
export function makeStubRewriterComplete(
  body: string,
  opts: { durationMs?: number; slotId?: number } = {},
): RewriterLlmComplete {
  return async (params): Promise<CompletionResult> => ({
    content: body,
    reasoningContent: "",
    timing: {
      promptMs: 0,
      predictedMs: opts.durationMs ?? 1,
      promptTokens: 0,
      predictedTokens: 0,
    },
    cacheHitTokens: 0,
    slotId: opts.slotId ?? params.slotId,
    modelId: null,
    stop: true,
    truncated: false,
  });
}

/**
 * Metrics observer — minimal `AgentMetrics`-shaped surface that
 * records the outcome the runner reports without pulling in the
 * real collector. Only `recordRetrieveRewriter` is implemented;
 * all other methods are no-ops because the runner never calls
 * them.
 */
export interface RewriterRecorded {
  outcome: RewriterOutcome;
  durationMs: number;
}

export function makeRecordingMetrics(): {
  metrics: AgentMetrics;
  records: RewriterRecorded[];
} {
  const records: RewriterRecorded[] = [];
  // Cast through `unknown` — the runner only uses
  // `metrics?.recordRetrieveRewriter?.(...)`; other surface methods
  // are never invoked here, so a partial object is safe.
  const metrics = {
    recordRetrieveRewriter(sample: RewriterRecorded): void {
      records.push({
        outcome: sample.outcome,
        durationMs: sample.durationMs,
      });
    },
  } as unknown as AgentMetrics;
  return { metrics, records };
}

export interface IsolatedRewriterInput {
  sessionId: string;
  userMessage: string;
  history: readonly RewriterHistoryTurn[];
  signal?: AbortSignal;
}

export interface IsolatedRewriterResult {
  /** What the runner returned — either the rewrite or the raw msg. */
  rewritten: string;
  /** The outcome the runner reported through `recordRetrieveRewriter`. */
  outcome: RewriterOutcome;
  durationMs: number;
  slotIdSeen: number;
}

export interface IsolatedRewriterDeps {
  llmComplete: RewriterLlmComplete;
  timeoutMs: number;
}

/**
 * Run one rewriter scenario through the production runner and
 * report what happened.
 */
export async function runIsolatedRewriter(
  input: IsolatedRewriterInput,
  deps: IsolatedRewriterDeps,
): Promise<IsolatedRewriterResult> {
  let slotIdSeen = NaN;
  const wrappedLlm: RewriterLlmComplete = async (params) => {
    slotIdSeen = params.slotId;
    return deps.llmComplete(params);
  };
  const { metrics, records } = makeRecordingMetrics();
  const runner: QueryRewriterRunner = createQueryRewriterRunner({
    llmComplete: wrappedLlm,
    timeoutMs: deps.timeoutMs,
    metrics,
  });
  const ac = new AbortController();
  if (input.signal) {
    if (input.signal.aborted) ac.abort();
    else input.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  const rewritten = await runner.maybeRewrite({
    sessionId: input.sessionId,
    userMessage: input.userMessage,
    history: input.history,
    signal: ac.signal,
  });
  const last = records[records.length - 1];
  return {
    rewritten,
    outcome: last?.outcome ?? "failed",
    durationMs: last?.durationMs ?? 0,
    slotIdSeen: Number.isFinite(slotIdSeen) ? slotIdSeen : REWRITER_SLOT_ID,
  };
}
