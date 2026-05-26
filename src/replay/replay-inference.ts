import type { CompletionResult } from "../llm/llama-server-client.js";
import type { CompletionRequest } from "../llm/provider/completion-types.js";

import type { TraceEvent } from "../tracing/index.js";
import { iterateTraceFile } from "../cli/trace-file-io.js";

export interface TextCompletionReplayClient {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface ReplayInferenceOptions {
  path: string;
  /** Provider or legacy llama client implementing `complete`. */
  llama: TextCompletionReplayClient;
  grammar: string;
  /** Replay only a specific step; when omitted, every recorded prompt is rerun. */
  stepIndex?: number;
  /** Slot id for the llama-server call. Defaults to `0`. */
  slotId?: number;
}

export interface ReplayInferenceStep {
  turnIndex: number;
  stepIndex: number;
  recordedContent: string;
  currentContent: string;
  contentMatches: boolean;
  recordedPredictedTokens: number | null;
  currentPredictedTokens: number | null;
}

export interface ReplayInferenceReport {
  sessionId: string;
  steps: ReplayInferenceStep[];
}

/**
 * Re-run llama-server with the recorded prompts and compare the
 * completions to the originals. Useful for validating model behaviour
 * across llama-server upgrades or grammar changes — does NOT attempt to
 * normalise non-determinism, so deterministic sampling (temperature=0,
 * fixed seed) is recommended on the recording side.
 */
export async function replayInference(
  options: ReplayInferenceOptions,
): Promise<ReplayInferenceReport> {
  const { path, llama, grammar } = options;
  const slotId = options.slotId ?? 0;
  const captured: Array<{
    turnIndex: number;
    stepIndex: number;
    prompt: string;
  }> = [];
  const recordedCompletions = new Map<
    string,
    Extract<TraceEvent, { type: "llm_completion" }>
  >();
  let sessionId = "";

  for await (const event of iterateTraceFile(path)) {
    if (event.type === "session_started") {
      sessionId = event.sessionId;
      continue;
    }
    if (event.type === "prompt_captured") {
      if (
        options.stepIndex !== undefined &&
        event.stepIndex !== options.stepIndex
      ) {
        continue;
      }
      captured.push({
        turnIndex: event.turnIndex,
        stepIndex: event.stepIndex,
        prompt: event.tail,
      });
      continue;
    }
    if (event.type === "llm_completion" && event.attempt === 1) {
      recordedCompletions.set(`${event.turnIndex}:${event.stepIndex}`, event);
    }
  }

  const steps: ReplayInferenceStep[] = [];
  for (const entry of captured) {
    const recorded = recordedCompletions.get(
      `${entry.turnIndex}:${entry.stepIndex}`,
    );
    const result: CompletionResult = await llama.complete({
      prompt: entry.prompt,
      grammar,
      slotId,
      sessionId,
      cachePrompt: false,
    });
    steps.push({
      turnIndex: entry.turnIndex,
      stepIndex: entry.stepIndex,
      recordedContent: recorded?.content ?? "",
      currentContent: result.content,
      contentMatches: (recorded?.content ?? "") === result.content,
      recordedPredictedTokens: recorded?.timing?.predictedTokens ?? null,
      currentPredictedTokens: result.timing?.predictedTokens ?? null,
    });
  }

  return { sessionId, steps };
}
