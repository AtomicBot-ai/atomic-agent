/**
 * Which wire mode a turn's tool calls should use on an external local
 * engine (Ollama, LM Studio), judged by the same rules the contract probe
 * judges a route by (ATO-642).
 *
 * `native_tools` sends `tools` and reads `tool_calls` back: the server's
 * own parser turns the model's tool-call text into structured calls. When
 * that parser does not know the model's format, the calls come back with
 * no name, a name nobody offered, arguments that are not JSON, or not at
 * all, with the raw markup left in the reply text. `json_schema` sends no
 * `tools`, asks for a JSON reply through `response_format` instead and
 * reads the calls out of that JSON (`openai/json-schema-tools.ts`).
 *
 * Two inputs can switch a model over, both read here so they cannot
 * disagree about what a broken native call is:
 *
 *  - a contract probe verdict (`toolCallModeAfterProbe`);
 *  - a live native reply (`nativeToolReplyLooksMalformed`), which reads
 *    each call with the probe's own `argumentsAreDispatchable`.
 */

import { argumentsAreDispatchable } from "./classify-contract-probe.js";
import type { ProviderContractStatus } from "./contract-probe-types.js";

export type ToolCallWireMode = "native_tools" | "json_schema";

/**
 * The mode a probe verdict argues for, or `null` when the verdict says
 * nothing about tool calling (auth, quota, timeouts, a prose answer).
 *
 * Only verdicts about the tool-call contract itself move a model to
 * `json_schema`: deltas that never assembled into a callable tool, a
 * route that refuses every request carrying `tools`, and a route that
 * answered a forced call in prose and called nothing under `auto` either.
 */
export function toolCallModeAfterProbe(
  status: ProviderContractStatus,
): ToolCallWireMode | null {
  switch (status) {
    case "tools_supported":
    case "forced_tool_choice_rejected":
      return "native_tools";
    case "malformed_tool_call":
    case "tools_payload_rejected":
    case "forced_tool_choice_ignored":
      return "json_schema";
    default:
      return null;
  }
}

export interface NativeToolReplyObservation {
  /** The `tool_calls` the reply carried, as the provider assembled them. */
  readonly toolCalls?: ReadonlyArray<{
    function: { name: string; arguments: string };
  }>;
  /** The reply text. */
  readonly content: string;
  /** Wire names of the functions the request offered. */
  readonly offeredNames: ReadonlySet<string>;
  /** `finish_reason`; a reply cut by the output cap is not judged. */
  readonly finishReason?: string | null;
}

/**
 * Tool-call markup a server's parser left in the reply text: the reply
 * starts with a known tool-call opener, or with a bare `{"name": …`
 * object. Anchored to the start on purpose, so an answer that quotes the
 * syntax in passing is not read as a failed call.
 */
const LEAKED_TOOL_CALL_RE =
  /^\s*(?:<tool_call>|<\|tool_call|<\|tool_calls_section_begin\|>|\[TOOL_CALLS\]|<function[=>]|<\|python_tag\|>|<start_function_call>|\{\s*"name"\s*:)/;

/**
 * Whether a native-tools reply shows the server's tool-call parser
 * failing: a call that could never be dispatched, or no call at all with
 * the model's own tool-call markup left in `content`.
 *
 * A clean reply (a dispatchable call, or a plain answer) is `false`, and
 * so is a reply cut by `finish_reason: "length"`: a half-written call is
 * the output cap's doing, not the parser's.
 */
export function nativeToolReplyLooksMalformed(
  reply: NativeToolReplyObservation,
): boolean {
  if (reply.finishReason === "length") return false;
  const calls = reply.toolCalls ?? [];
  if (calls.length > 0) {
    return calls.some(
      (call) =>
        call.function.name.length === 0 ||
        !isOffered(call.function.name, reply.offeredNames) ||
        !argumentsAreDispatchable(call.function.arguments),
    );
  }
  return LEAKED_TOOL_CALL_RE.test(reply.content);
}

/**
 * A name the request offered, as sent or with its dots written as the
 * wire's `__` (the adapter maps both back to the same tool, so neither is
 * a parser failure).
 */
function isOffered(name: string, offered: ReadonlySet<string>): boolean {
  return offered.has(name) || offered.has(name.replace(/\./g, "__"));
}
