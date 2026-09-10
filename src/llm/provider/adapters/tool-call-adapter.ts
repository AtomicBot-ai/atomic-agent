import type { ToolDescriptor } from "../../../prompt/stable-prefix.js";
import type { ToolCallBatch } from "../../grammar/tool-call-grammar.js";
import type { OpenAiToolCall } from "../completion-types.js";

/**
 * The outgoing side of one fact: the resolved model declares
 * `supportsTools: "strict"`, so the provider should constrain the
 * decode to the tool schemas. It is off unless the operator sets that
 * level by hand, and an adapter that has no strict mode ignores it.
 */
export interface ToolDefinitionOptions {
  strict?: boolean;
}

/**
 * The incoming side, and NOT a boolean. Strict is granted per tool —
 * the adapter marks only the functions whose schema it could rewrite
 * faithfully — so undoing the rewrite on the way back in has to be per
 * tool too. This carries the provider-facing (escaped) names that were
 * actually marked, i.e. exactly the calls that were decoded against a
 * schema we changed. A call to a tool that shipped unconverted is
 * indistinguishable from the flag-off payload and must be left alone.
 */
export interface ToolBatchOptions {
  strictToolNames?: ReadonlySet<string>;
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
  /**
   * The provider-facing names `descriptorsToTools` emitted under the
   * provider's strict mode, for the same descriptors and options —
   * fed straight back into `toolCallsToBatch`. An adapter with no
   * strict mode omits this and every call is parsed as it is today.
   */
  strictToolNames?(
    descriptors: readonly ToolDescriptor[],
    options?: ToolDefinitionOptions,
  ): ReadonlySet<string>;
  /** Convert provider tool_calls into the runtime `ToolCallBatch`. */
  toolCallsToBatch(
    toolCalls: ReadonlyArray<OpenAiToolCall>,
    reasoningText?: string,
    options?: ToolBatchOptions,
  ): ToolCallBatch;
}
