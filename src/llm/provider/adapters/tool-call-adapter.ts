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
 * The incoming side, and NOT a boolean — nor even a set of tool names.
 * Strict is granted per tool (the adapter marks only the functions
 * whose schema it could rewrite), but the rewrite that has to be undone
 * is per PROPERTY: only an argument the converter moved from optional
 * into `required` carries a `null` the schema put there. An argument
 * that was already required went out byte-identical, so its `null` is
 * the model answering the tool's own schema — deleting it would hand an
 * MCP server a call missing a required field.
 *
 * So this maps a provider-facing (escaped) function name to the
 * argument names whose optionality the rewrite erased. A function
 * absent from the map shipped unconverted; a name absent from its set
 * was never widened. Both are left exactly as they arrive.
 */
export interface ToolBatchOptions {
  strictWidenedArgs?: ReadonlyMap<string, ReadonlySet<string>>;
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
   * For the same descriptors and options `descriptorsToTools` was
   * called with: each function emitted under the provider's strict mode
   * mapped to the arguments whose optionality that rewrite erased. Fed
   * straight back into `toolCallsToBatch`. An adapter with no strict
   * mode omits this and every call is parsed as it is today.
   */
  strictWidenedArgs?(
    descriptors: readonly ToolDescriptor[],
    options?: ToolDefinitionOptions,
  ): ReadonlyMap<string, ReadonlySet<string>>;
  /** Convert provider tool_calls into the runtime `ToolCallBatch`. */
  toolCallsToBatch(
    toolCalls: ReadonlyArray<OpenAiToolCall>,
    reasoningText?: string,
    options?: ToolBatchOptions,
  ): ToolCallBatch;
}
