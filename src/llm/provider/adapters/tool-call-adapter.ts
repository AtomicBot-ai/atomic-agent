import type { ToolDescriptor } from "../../../prompt/stable-prefix.js";
import type { ToolCallBatch } from "../../grammar/tool-call-grammar.js";
import type { OpenAiToolCall } from "../completion-types.js";

/**
 * Both directions carry the same one fact: the resolved model declares
 * `supportsTools: "strict"`, so the provider should constrain the
 * decode to the tool schemas. It is off unless the operator sets that
 * level by hand, and an adapter that has no strict mode ignores it.
 */
export interface ToolDefinitionOptions {
  strict?: boolean;
}

export interface ToolBatchOptions {
  strict?: boolean;
}

/**
 * Maps between atomic-agent tool descriptors and a provider's native
 * tool-calling wire shape. OpenAI-compatible providers use
 * `OpenAiToolCallAdapter`; future Anthropic/Gemini adapters implement
 * this interface with their own shapes.
 */
export interface ToolCallAdapter {
  /** Escape a qualified tool name for the provider's function-name regex. */
  nameEscape(qualifiedName: string): string;
  /** Restore the atomic-agent qualified name from a provider function name. */
  nameUnescape(providerName: string): string;
  /** Build provider-native tool definitions from prompt descriptors. */
  descriptorsToTools(
    descriptors: readonly ToolDescriptor[],
    options?: ToolDefinitionOptions,
  ): ReadonlyArray<Record<string, unknown>>;
  /** Convert provider tool_calls into the runtime `ToolCallBatch`. */
  toolCallsToBatch(
    toolCalls: ReadonlyArray<OpenAiToolCall>,
    reasoningText?: string,
    options?: ToolBatchOptions,
  ): ToolCallBatch;
}
