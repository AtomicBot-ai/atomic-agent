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

/**
 * Whether an emitted tool array actually carries a `strict: true`
 * function — i.e. whether the provider is being asked to constrain the
 * decode for at least one tool.
 *
 * The reason this exists rather than a `strictTools` boolean read
 * straight off the deps: strict is granted PER TOOL. `descriptorsToTools`
 * marks only the functions whose schema it could rewrite, and an
 * adapter with no strict mode ignores the option entirely, so "the
 * operator asked for strict" and "this request contains strict tools"
 * are different facts. Everything downstream that has to react to
 * strict decoding — `parallel_tool_calls`, the tagged-response
 * decoder's reading of `required` — keys off the array, which cannot
 * disagree with itself.
 *
 * The shape is the OpenAI one because that is the shape
 * `descriptorsToTools` returns for every adapter in the repo; a tool
 * that is not a function, or carries no `strict`, simply does not
 * match.
 */
export function hasStrictFunctionTools(
  tools: ReadonlyArray<Record<string, unknown>> | undefined,
): boolean {
  if (!tools) return false;
  return tools.some((tool) => {
    const fn = tool.function;
    return (
      fn !== null &&
      typeof fn === "object" &&
      (fn as Record<string, unknown>).strict === true
    );
  });
}
