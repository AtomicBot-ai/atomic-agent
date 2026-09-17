import type {
  CompletionRequest,
  CompletionResult,
  OpenAiToolCall,
} from "../completion-types.js";
import {
  coerceJsonSchemaValue,
  validateJsonSchemaValue,
} from "./coerce-json-schema-value.js";

type OfferedTool = {
  wireName: string;
  schema: Record<string, unknown>;
  properties: Record<string, Record<string, unknown>>;
  required: ReadonlySet<string>;
};

/**
 * One `<tool_call>` block, in either dialect the parser accepts:
 *  - Qwen's XML-ish form, `<function=NAME><parameter=K>V</parameter>…`,
 *    whose values are strings the schema coerces (`parameters`);
 *  - the Hermes / ChatML form, `{"name": NAME, "arguments": {…}}`, whose
 *    values are already typed JSON (`args`).
 */
type TaggedCall =
  | {
      name: string;
      parameters: Array<{ name: string; value: string }>;
    }
  | { name: string; args: Record<string, unknown> };

const TOOL_CALL_BLOCK_RE = /\s*<tool_call>([\s\S]*?)<\/tool_call>/gy;
const QWEN_FUNCTION_RE = /^\s*<function=([^>\n]+)>([\s\S]*?)<\/function>\s*$/;
const PARAMETER_RE = /\s*<parameter=([^>\n]+)>([\s\S]*?)<\/parameter>/gy;

export interface TaggedToolAdaptOptions {
  /**
   * Also read a tagged call out of `reasoning_content` when `content`
   * holds none (#105 — Qwen thinking models put the call there). The
   * adapter's own default, and what the Qwen kind sends; every other
   * kind passes `false`, because on those services the reasoning channel
   * is scratch space and a call quoted while the model thinks is not a
   * call.
   */
  fromReasoning?: boolean;
}

export function adaptQwenTaggedToolResponse(
  response: Record<string, unknown>,
  request: Pick<CompletionRequest, "tools">,
  options: TaggedToolAdaptOptions = {},
): Record<string, unknown> {
  const choices = response.choices as
    Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  if (
    !choice ||
    !message ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
    !request.tools?.length
  ) {
    return response;
  }

  const offered = indexOfferedTools(request.tools);
  const contentCalls = parseSource(message.content, offered);
  // #105 allows the tagged call in either field. `null` means content held
  // tag noise that failed to parse — fail open to reasoning_content rather
  // than fail closed on the first field alone. An empty-but-clean content
  // (`[]`) takes the same reasoning path, so `fromReasoning` covers both.
  const fromReasoning = contentCalls === null || contentCalls.length === 0;
  const toolCalls = fromReasoning
    ? options.fromReasoning === false
      ? null
      : parseSource(message.reasoning_content, offered)
    : contentCalls;
  if (!toolCalls || toolCalls.length === 0) return response;

  const nextMessage: Record<string, unknown> = {
    ...message,
    content: fromReasoning ? message.content : null,
    tool_calls: toolCalls,
  };
  if (fromReasoning) nextMessage.reasoning_content = null;
  const nextChoices = [...choices];
  nextChoices[0] = {
    ...choice,
    message: nextMessage,
    finish_reason: "tool_calls",
  };
  return { ...response, choices: nextChoices };
}

/**
 * CompletionResult-shaped wrapper for the streaming path. The provider
 * buffers deltas into a `CompletionResult`, so it cannot call the raw
 * wire-shape adapter above; this rebuilds the minimal wire envelope the
 * adapter inspects (`content` / `reasoning_content`), runs the same adapt
 * seam, and maps the result back. `usage`/`modelId`/`finishReason` come
 * from the buffered stream so they survive the round-trip untouched.
 */
export function adaptQwenCompletionResult(
  result: CompletionResult,
  request: Pick<CompletionRequest, "tools">,
  options: TaggedToolAdaptOptions = {},
): CompletionResult {
  const wire = {
    choices: [
      {
        message: {
          content: result.content,
          reasoning_content: result.reasoningContent,
          tool_calls: result.toolCalls ?? [],
        },
        finish_reason: result.finishReason ?? null,
      },
    ],
  };
  const adapted = adaptQwenTaggedToolResponse(wire, request, options);
  // Declined: the completion is exactly what the provider returned, and
  // rebuilding it would turn an absent `toolCalls` into an empty array.
  if (adapted === wire) return result;
  const choice = (adapted.choices as Array<Record<string, unknown>>)[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  if (!message) return result;
  const toolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as CompletionResult["toolCalls"])
    : result.toolCalls;
  return {
    ...result,
    content: typeof message.content === "string" ? message.content : "",
    reasoningContent:
      typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : "",
    toolCalls,
    finishReason:
      typeof choice?.finish_reason === "string"
        ? choice.finish_reason
        : result.finishReason,
  };
}

function indexOfferedTools(
  tools: NonNullable<CompletionRequest["tools"]>,
): ReadonlyMap<string, OfferedTool> {
  const offered = new Map<string, OfferedTool>();
  for (const tool of tools) {
    const fn = asRecord(tool.function);
    if (!fn || typeof fn.name !== "string") continue;
    const parameters = asRecord(fn.parameters);
    const properties = asRecord(parameters?.properties) ?? {};
    const declared = Array.isArray(parameters?.required)
      ? parameters.required.filter(
          (name): name is string => typeof name === "string",
        )
      : [];
    // A `strict: true` function's `required` lists EVERY property: that
    // is the shape the provider's strict decoder demands, and an
    // optional argument is spelled there as a `null` union instead of
    // an absent key (see `strict-tool-schema.ts`). Nothing constrains a
    // `<tool_call>` decode to it — the model writes prose tags — so
    // reading that inflated list literally rejects every realistic
    // tagged call for omitting an optional, `parseSource` returns
    // `null`, and the step sees text where a tool call should be.
    // Reading the strict spelling the way strict means it costs only
    // the check that a genuinely required nullable argument is present,
    // which the tool's own validator makes again downstream.
    const required =
      fn.strict === true
        ? declared.filter((name) => !admitsNull(asRecord(properties[name])))
        : declared;
    const entry: OfferedTool = {
      wireName: fn.name,
      schema:
        parameters === null
          ? { type: "object", properties: {} }
          : { ...parameters, required },
      properties: Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [
          name,
          asRecord(schema) ?? {},
        ]),
      ),
      required: new Set(required),
    };
    offered.set(fn.name, entry);
  }
  for (const entry of [...offered.values()]) {
    const dotted = entry.wireName.replace(/__/g, ".");
    const escaped = entry.wireName.replace(/\./g, "__");
    if (!offered.has(dotted)) offered.set(dotted, entry);
    if (!offered.has(escaped)) offered.set(escaped, entry);
  }
  return offered;
}

function parseSource(
  source: unknown,
  offered: ReadonlyMap<string, OfferedTool>,
): OpenAiToolCall[] | null {
  if (typeof source !== "string" || source.trim().length === 0) return [];
  if (!source.includes("<tool_call>")) return [];
  const tagged = parseTaggedCalls(source);
  if (!tagged) return null;

  const calls: OpenAiToolCall[] = [];
  for (const taggedCall of tagged) {
    const tool = offered.get(taggedCall.name.trim());
    if (!tool) return null;
    const args =
      "args" in taggedCall
        ? coerceTypedArguments(taggedCall.args, tool)
        : coerceArguments(taggedCall.parameters, tool);
    if (!args) return null;
    calls.push({
      id: `call_qwen_tagged_${calls.length}`,
      type: "function",
      function: {
        name: tool.wireName,
        arguments: JSON.stringify(args),
      },
    });
  }
  return calls;
}

/**
 * Every `<tool_call>` block in `source`, which must consist of nothing
 * else: text before, between or after the blocks makes the whole thing a
 * reply that quotes the syntax, and `null` says so.
 */
function parseTaggedCalls(source: string): TaggedCall[] | null {
  const calls: TaggedCall[] = [];
  let offset = 0;
  while (offset < source.length) {
    TOOL_CALL_BLOCK_RE.lastIndex = offset;
    const match = TOOL_CALL_BLOCK_RE.exec(source);
    if (!match) return source.slice(offset).trim().length === 0 ? calls : null;
    const call = parseTaggedCallBody(match[1] ?? "");
    if (!call) return null;
    calls.push(call);
    offset = TOOL_CALL_BLOCK_RE.lastIndex;
  }
  return calls;
}

/** The inside of one block, in whichever dialect it is written. */
function parseTaggedCallBody(body: string): TaggedCall | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  const qwen = QWEN_FUNCTION_RE.exec(trimmed);
  if (qwen) {
    const parameters = parseParameters(qwen[2] ?? "");
    if (!parameters) return null;
    return { name: qwen[1] ?? "", parameters };
  }
  if (!trimmed.startsWith("{")) return null;
  // Hermes / ChatML: `{"name": …, "arguments": {…}}`. Some fine-tunes
  // write `parameters` for the arguments object; a bare name with no
  // arguments object at all is a call with none.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record || typeof record.name !== "string") return null;
  const args = asRecord(record.arguments) ?? asRecord(record.parameters);
  if (
    args === null &&
    record.arguments !== undefined &&
    record.parameters !== undefined
  ) {
    return null;
  }
  return { name: record.name, args: args ?? {} };
}

/**
 * Hermes arguments arrive typed, so only a string standing where the
 * schema wants something else is coerced — the same reading the Qwen
 * form gets for every value — and the result is validated the same way.
 */
function coerceTypedArguments(
  raw: Record<string, unknown>,
  tool: OfferedTool,
): Record<string, unknown> | null {
  const args = Object.create(null) as Record<string, unknown>;
  try {
    for (const [name, value] of Object.entries(raw)) {
      if (!Object.hasOwn(tool.properties, name)) {
        throw new Error("invalid parameter");
      }
      const schema = tool.properties[name] ?? {};
      args[name] =
        typeof value === "string" && !admitsString(schema)
          ? coerceJsonSchemaValue(value, schema)
          : value;
    }
    for (const name of tool.required) {
      if (!Object.hasOwn(args, name))
        throw new Error("missing required parameter");
    }
    if (!validateJsonSchemaValue(args, tool.schema)) {
      throw new Error("arguments do not match offered schema");
    }
    return args;
  } catch {
    return null;
  }
}

/** Whether a property schema takes a string as it is. */
function admitsString(schema: Record<string, unknown>): boolean {
  const type = schema.type;
  if (type === undefined) return true;
  if (type === "string") return true;
  if (Array.isArray(type) && type.includes("string")) return true;
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    return anyOf.some((branch) => {
      const record = asRecord(branch);
      return record !== null && admitsString(record);
    });
  }
  return false;
}

function parseParameters(
  source: string,
): Array<{ name: string; value: string }> | null {
  const parameters: Array<{ name: string; value: string }> = [];
  let offset = 0;
  while (offset < source.length) {
    PARAMETER_RE.lastIndex = offset;
    const match = PARAMETER_RE.exec(source);
    if (!match)
      return source.slice(offset).trim().length === 0 ? parameters : null;
    parameters.push({
      name: (match[1] ?? "").trim(),
      value: (match[2] ?? "").trim(),
    });
    offset = PARAMETER_RE.lastIndex;
  }
  return parameters;
}

function coerceArguments(
  parameters: Array<{ name: string; value: string }>,
  tool: OfferedTool,
): Record<string, unknown> | null {
  const args = Object.create(null) as Record<string, unknown>;
  try {
    for (const parameter of parameters) {
      if (
        !Object.hasOwn(tool.properties, parameter.name) ||
        Object.hasOwn(args, parameter.name)
      ) {
        throw new Error("invalid parameter");
      }
      args[parameter.name] = coerceJsonSchemaValue(
        parameter.value,
        tool.properties[parameter.name] ?? {},
      );
    }
    for (const name of tool.required) {
      if (!Object.hasOwn(args, name))
        throw new Error("missing required parameter");
    }
    if (!validateJsonSchemaValue(args, tool.schema)) {
      throw new Error("arguments do not match offered schema");
    }
    return args;
  } catch {
    return null;
  }
}

/** Whether a property schema accepts an explicit `null`. */
function admitsNull(schema: Record<string, unknown> | null): boolean {
  if (!schema) return false;
  const type = schema.type;
  if (type === "null") return true;
  if (Array.isArray(type) && type.includes("null")) return true;
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    return anyOf.some((branch) => admitsNull(asRecord(branch)));
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
