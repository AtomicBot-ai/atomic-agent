/**
 * Shared completion request/response shapes for every text LLM provider.
 * `LlamaServerClient` and cloud adapters both speak this surface so the
 * agent loop stays provider-agnostic above the registry seam.
 */

export type ToolCallTransport = "grammar" | "native_tools";

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Prompt tokens the service served from its prompt cache
   * (`prompt_tokens_details.cached_tokens` on OpenAI, OpenRouter and
   * Gemini's compatibility layer). A subset of `promptTokens`, priced at
   * the model's `cacheRead` rate when one is known. Absent — not zero —
   * when the service did not report it.
   */
  cachedTokens?: number;
}

/**
 * One turn of the packed conversation, as the prompt builder renders it:
 * the same rows `### conversation` carries as text, with each
 * tool-result body already capped exactly as the text form caps it.
 * Provider-neutral on purpose — a native-tools provider lays these out as
 * real chat messages, a grammar provider never reads them.
 */
export type PromptTurn =
  | { kind: "user"; text: string }
  | { kind: "assistant_reply"; text: string }
  | { kind: "assistant_tool_call"; tool: string; args: Record<string, unknown> }
  | {
      kind: "tool_result";
      tool: string;
      status: "ok" | "error";
      body: string;
      truncated: boolean;
    };

/**
 * The prompt as structure instead of as one string: the three zones a
 * native-message request lays out as `system`, history and a final
 * `user` message. `prompt` (the flat text) is always present beside it
 * and is what every other transport sends; the two are built from the
 * same packed conversation, so they cannot disagree about what the
 * model sees.
 */
export interface PromptMessages {
  /** The stable prefix, byte for byte. */
  system: string;
  /** The packer's one-line recap of dropped turns, or `null`. */
  droppedSummary: string | null;
  /** The visible conversation, oldest first. */
  turns: ReadonlyArray<PromptTurn>;
  /** The variable tail without `### conversation`: the final user message. */
  tail: string;
}

export interface CompletionRequest {
  prompt: string;
  /**
   * The same prompt as structure. Set only for main-turn requests built
   * for a native-tools link; providers that lay history out as real
   * messages read it, everything else ignores it and sends `prompt`.
   */
  messages?: PromptMessages;
  grammar?: string;
  slotId?: number;
  cachePrompt?: boolean;
  stop?: string[];
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  seed?: number;
  repeatPenalty?: number;
  repeatLastN?: number;
  sessionId?: string;
  signal?: AbortSignal;
  imageData?: ReadonlyArray<{ id: number; data: string }>;
  /** OpenAI tools path — ignored by grammar-only providers. */
  tools?: ReadonlyArray<Record<string, unknown>>;
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  /**
   * OpenAI-compatible Structured Outputs envelope. When set, the
   * provider attaches `response_format: { type: "json_schema", ... }`
   * to the request so the model is forced to emit valid JSON matching
   * `schema`. Used by reflection/link-gen/vote/rewriter/distill
   * sub-runners on cloud providers — GBNF (`grammar`) cannot be
   * enforced over OpenAI-compatible APIs, so this is the cross-vendor
   * equivalent. Ignored by grammar-only providers (llama-server) —
   * they rely on `grammar` instead.
   */
  responseFormat?: ResponseFormatJsonSchema;
  /**
   * How hard a reasoning model should think on this completion. Spelled
   * per vendor by the body builder (`reasoning: { effort }` on
   * OpenRouter, `reasoning_effort` on OpenAI-compatible services) and
   * omitted for kinds that document neither. Ignored by grammar-only
   * providers. Set by the fusion fan-out for its workers.
   */
  reasoningEffort?: "low" | "medium" | "high";
}

/**
 * OpenAI-compatible Structured Outputs descriptor. Mirrors the
 * `response_format` payload accepted by chat-completions when
 * `type === "json_schema"`. `strict: true` is the recommended
 * default — it makes the provider validate against `schema` server-side
 * and rejects malformed completions before they hit our parsers.
 */
export interface ResponseFormatJsonSchema {
  /** Short identifier exposed to the provider (must match `^[a-zA-Z0-9_-]+$`). */
  name: string;
  /** Human-readable description of what the schema captures. Optional. */
  description?: string;
  /** JSON Schema object. Should be self-contained — no $ref. */
  schema: Record<string, unknown>;
  /**
   * When true, the provider enforces strict adherence to `schema`
   * (every property in `required`, no extra fields beyond what
   * `additionalProperties: false` allows). Defaults to true at the
   * provider adapter level.
   */
  strict?: boolean;
}

export interface CompletionTiming {
  promptMs: number;
  predictedMs: number;
  promptTokens: number;
  predictedTokens: number;
}

/**
 * Why the runtime ended a completion itself, before the provider did.
 *
 * `fabricated_transcript`: the plain content kept writing atag's own text
 * transcript (`assistant_tool_call:` / `tool_result[...]:` lines) instead
 * of calling tools, so the stream was aborted
 * (`createFabricatedTranscriptWatcher`). `calls` / `results` are the
 * transcript lines seen when it was cut. Not a truncation and not a
 * provider failure: the completion is judged like one whose text was
 * detected as fabricated after it finished.
 */
export interface CompletionEarlyStop {
  reason: "fabricated_transcript";
  calls: number;
  results: number;
}

export interface CompletionResult {
  content: string;
  reasoningContent: string;
  stop: boolean;
  truncated: boolean;
  timing: CompletionTiming;
  cacheHitTokens: number;
  slotId: number;
  modelId: string | null;
  /** Populated by cloud providers from `usage` blocks. */
  usage?: CompletionUsage;
  /** Raw OpenAI tool_calls when transport is native_tools. */
  toolCalls?: ReadonlyArray<OpenAiToolCall>;
  finishReason?: string | null;
  /** Set when the runtime cut the completion short. See `CompletionEarlyStop`. */
  earlyStop?: CompletionEarlyStop;
  /**
   * The output cap the request actually carried on the wire
   * (`max_tokens`, or `max_completion_tokens` from a passthrough); `null`
   * when it carried none, so any cut was the provider's own limit.
   * Absent when the provider does not report it — callers then fall back
   * to the cap they asked for.
   */
  sentMaxTokens?: number | null;
  /**
   * Tool-call transport of the provider that actually served this
   * completion. Providers never set it — it is stamped by the fallback
   * chain wrapper so the caller parses the response with the transport of
   * the link that answered, not the primary's. Absent on the direct
   * (non-wrapped) path, where the caller's own `toolTransport` is
   * authoritative.
   */
  servedTransport?: ToolCallTransport;
}

export interface OpenAiToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamChunk {
  delta: string;
  reasoningDelta: string;
  done: boolean;
  /**
   * Tool-call transport of the link that is serving this stream.
   * Providers never set it — the fallback streamer seam stamps it on
   * every chunk so live consumers (the step executor's stream parser)
   * can adapt to a cross-transport fallover BEFORE the final return
   * value arrives: `CompletionResult.servedTransport` only exists once
   * the stream finishes, which is too late to classify reasoning deltas
   * live. Absent on the direct (non-wrapped) path, where the caller's
   * configured `toolTransport` is authoritative.
   */
  servedTransport?: ToolCallTransport;
}

export interface StreamFinalResult {
  content: string;
  reasoningContent: string;
  toolCalls?: ReadonlyArray<OpenAiToolCall>;
  finishReason?: string | null;
  usage?: CompletionUsage;
  modelId?: string | null;
  /**
   * Whether the underlying transport actually delivered a trustworthy
   * terminal signal — an explicit provider `finish_reason` on any chunk,
   * or a parser-recognized terminal event (e.g. `[DONE]`) — before the
   * stream ended. `false` (or absent) means the connection just closed
   * (bare EOF / read error) without either: not asserted, so callers must
   * not treat an absent value as confirmation of a clean completion.
   */
  terminalObserved?: boolean;
  /**
   * Set when the consumer ended the stream itself. The tool calls on the
   * result are then only those whose arguments had fully arrived.
   */
  earlyStop?: CompletionEarlyStop;
}
