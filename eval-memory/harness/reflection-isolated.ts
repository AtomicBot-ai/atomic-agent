/**
 * Run a reflection call in isolation against a managed llama-server.
 *
 * Unlike the production `ReflectionRunner`, this helper does **not**
 * write to `ProfileStore` / `MemoryStore`. It only:
 *
 *   1. Builds the reflection prompt for `(userMessage, assistantReply)`.
 *   2. Calls the LLM with `REFLECTION_GRAMMAR`.
 *   3. Returns the parsed `ParsedReflection`.
 *
 * That keeps E3 a pure observation of "what would reflection have
 * extracted?", which is exactly the signal-to-noise question the
 * experiment is built around.
 */

import {
  buildReflectionPrompt,
  REFLECTION_GRAMMAR,
  parseReflectionOutput,
  type ParsedReflection,
  type ReflectionPromptInput,
} from "../../src/memory/reflection/index.js";

import type { LlmCompleteParams, LlmCompleteResult } from "./llm-client.js";

export interface IsolatedReflectionInput extends ReflectionPromptInput {
  /** Optional id surfaced into the trace for joining. */
  sessionId?: string;
  signal?: AbortSignal;
}

export interface IsolatedReflectionResult {
  parsed: ParsedReflection;
  raw: string;
  reasoning: string;
  durationMs: number;
  promptTokens: number | null;
  predictedTokens: number | null;
}

export type LlmCompleteFn = (params: LlmCompleteParams) => Promise<LlmCompleteResult>;

export interface IsolatedReflectionDeps {
  llmComplete: LlmCompleteFn;
  /** Stop tokens to defuse degenerate reasoning. Defaults to none. */
  stop?: readonly string[];
  /** Slot id. Defaults to -1 (no slot affinity) since we are in eval. */
  slotId?: number;
  /** Temperature. Defaults to 0.2 (matches reflection-runner defaults). */
  temperature?: number;
  /** Max tokens. Defaults to 512 — reflection output is tiny. */
  maxTokens?: number;
}

export async function runIsolatedReflection(
  input: IsolatedReflectionInput,
  deps: IsolatedReflectionDeps,
): Promise<IsolatedReflectionResult> {
  const prompt = buildReflectionPrompt({
    userMessage: input.userMessage,
    assistantReply: input.assistantReply,
  });
  const completionParams: LlmCompleteParams = {
    prompt,
    grammar: REFLECTION_GRAMMAR,
    slotId: deps.slotId ?? -1,
    temperature: deps.temperature ?? 0.2,
    maxTokens: deps.maxTokens ?? 512,
    cachePrompt: false,
  };
  if (input.sessionId !== undefined) completionParams.sessionId = input.sessionId;
  if (input.signal !== undefined) completionParams.signal = input.signal;
  if (deps.stop !== undefined) completionParams.stop = deps.stop;
  const result = await deps.llmComplete(completionParams);
  const parsed = parseReflectionOutput(result.content);
  return {
    parsed,
    raw: result.content,
    reasoning: result.reasoningContent,
    durationMs: result.durationMs,
    promptTokens: result.promptTokens,
    predictedTokens: result.predictedTokens,
  };
}
