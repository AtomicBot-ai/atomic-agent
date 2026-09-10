import type {
  CompletionRequest,
  CompletionResult,
  StreamChunk,
  ToolCallTransport,
} from "./completion-types.js";
import type { LlmProvider } from "./llm-provider.js";
import { openAiToolCallAdapter } from "./openai/openai-tool-call-adapter.js";

/**
 * Test fixture: an in-memory `LlmProvider` whose every completion is
 * answered by `serve`. The transport decides the capability shape the
 * way the real adapters do — native-tools providers carry the OpenAI
 * tool-call adapter and no slot affinity, grammar providers the reverse
 * — so a test can stand in either kind of link for the fallback seams,
 * the run-mode resolver, or a pinned fusion worker turn.
 *
 * `completeStream` answers with one `done` chunk carrying the whole
 * content; tests that need chunk-level behaviour build their own.
 */
export function fakeProvider(
  id: string,
  transport: ToolCallTransport,
  serve: (request: CompletionRequest) => Promise<CompletionResult>,
): LlmProvider {
  return {
    id,
    name: id,
    capabilities: {
      vision: false,
      visionSource: "absent",
      toolTransport: transport,
      contextWindow: 128_000,
      supportsParallelTools: transport === "native_tools",
      supportsSlotAffinity: transport === "grammar",
      supportsPromptCache: false,
      reasoningFormat: "none",
    },
    toolCallAdapter:
      transport === "native_tools" ? openAiToolCallAdapter : null,
    streamConsumer: null,
    complete: serve,
    async *completeStream(request) {
      const result = await serve(request);
      yield {
        delta: result.content,
        reasoningDelta: "",
        done: true,
      } as StreamChunk;
      return result;
    },
    async describeImage() {
      throw new Error("no vision");
    },
    async health() {
      return { reachable: true, status: 200, error: null, latencyMs: 1 };
    },
    async close() {},
  };
}

/** A minimal successful `CompletionResult` whose `modelId` names the link. */
export function fakeAnswer(id: string, content = "ok"): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {
      promptMs: 1,
      predictedMs: 1,
      promptTokens: 1,
      predictedTokens: 1,
    },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: `${id}-model`,
  };
}
