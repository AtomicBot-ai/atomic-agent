import type { CompletionRequest, OpenAiToolCall } from "../completion-types.js";
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

type TaggedCall = {
  name: string;
  parameters: Array<{ name: string; value: string }>;
};

const TOOL_CALL_RE = /\s*<tool_call>\s*<function=([^>\n]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/gy;
const PARAMETER_RE = /\s*<parameter=([^>\n]+)>([\s\S]*?)<\/parameter>/gy;

export function adaptQwenTaggedToolResponse(
  response: Record<string, unknown>,
  request: Pick<CompletionRequest, "tools">,
): Record<string, unknown> {
  const choices = response.choices as Array<Record<string, unknown>> | undefined;
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
  if (contentCalls === null) return response;
  const fromReasoning = contentCalls.length === 0;
  const toolCalls = fromReasoning
    ? parseSource(message.reasoning_content, offered)
    : contentCalls;
  if (!toolCalls || toolCalls.length === 0) return response;

  const nextMessage: Record<string, unknown> = {
    ...message,
    content: fromReasoning ? message.content : null,
    tool_calls: toolCalls,
  };
  if (fromReasoning) nextMessage.reasoning_content = null;
  const nextChoices = [...choices];
  nextChoices[0] = { ...choice, message: nextMessage, finish_reason: "tool_calls" };
  return { ...response, choices: nextChoices };
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
    const entry: OfferedTool = {
      wireName: fn.name,
      schema: parameters ?? { type: "object", properties: {} },
      properties: Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [name, asRecord(schema) ?? {}]),
      ),
      required: new Set(
        Array.isArray(parameters?.required)
          ? parameters.required.filter((name): name is string => typeof name === "string")
          : [],
      ),
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
    const args = coerceArguments(taggedCall.parameters, tool);
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

function parseTaggedCalls(source: string): TaggedCall[] | null {
  const calls: TaggedCall[] = [];
  let offset = 0;
  while (offset < source.length) {
    TOOL_CALL_RE.lastIndex = offset;
    const match = TOOL_CALL_RE.exec(source);
    if (!match) return source.slice(offset).trim().length === 0 ? calls : null;
    const parameters = parseParameters(match[2] ?? "");
    if (!parameters) return null;
    calls.push({ name: match[1] ?? "", parameters });
    offset = TOOL_CALL_RE.lastIndex;
  }
  return calls;
}

function parseParameters(
  source: string,
): Array<{ name: string; value: string }> | null {
  const parameters: Array<{ name: string; value: string }> = [];
  let offset = 0;
  while (offset < source.length) {
    PARAMETER_RE.lastIndex = offset;
    const match = PARAMETER_RE.exec(source);
    if (!match) return source.slice(offset).trim().length === 0 ? parameters : null;
    parameters.push({ name: (match[1] ?? "").trim(), value: (match[2] ?? "").trim() });
    offset = PARAMETER_RE.lastIndex;
  }
  return parameters;
}

function coerceArguments(
  parameters: TaggedCall["parameters"],
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
      if (!Object.hasOwn(args, name)) throw new Error("missing required parameter");
    }
    if (!validateJsonSchemaValue(args, tool.schema)) {
      throw new Error("arguments do not match offered schema");
    }
    return args;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
