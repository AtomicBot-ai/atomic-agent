import type {
  CompletionRequest,
  CompletionResult,
  OpenAiToolCall,
  ResponseFormatJsonSchema,
} from "../completion-types.js";
import { repairJsonText } from "../../grammar/repair-tool-call-json.js";
import { normalizeToolSchemaBooleans } from "./tool-schema-booleans.js";

/**
 * Tool calls through a JSON reply instead of `tools` (ATO-642).
 *
 * An external engine (Ollama, LM Studio) turns the model's tool-call text
 * into `tool_calls` with its own parser, and that parser only knows some
 * models' formats. Both engines also accept a JSON Schema for the reply
 * (`response_format: { type: "json_schema" }` on their OpenAI-compatible
 * route) and constrain decoding to it. So for a model whose native calls
 * break, the request goes out with no `tools`, a schema that admits
 * exactly one reply shape, and a short note telling the model about it;
 * the JSON that comes back is turned into ordinary `tool_calls`, and the
 * step above parses it like any native reply.
 *
 * The reply shape: `{"calls": [item, ...]}`, where an item is either a
 * call, `{"name": <offered wire name>, "arguments": {...}}`, its
 * `arguments` held to that tool's own `parameters` schema (the whole
 * schema the request offered, one `anyOf` branch per tool), or the plain
 * final answer, `{"answer": "<text>"}`.
 */

export const JSON_SCHEMA_TOOLS_FORMAT_NAME = "atomic_tool_calls";

/** What a schema-mode request was built from, for reading its reply back. */
export interface JsonSchemaToolPlan {
  /** The request that goes on the wire: no `tools`, a `responseFormat`. */
  readonly wireRequest: CompletionRequest;
  /** Wire names of the offered functions. */
  readonly offeredNames: ReadonlySet<string>;
}

/**
 * The schema-mode request for `request`, or `null` when there is nothing
 * to translate: no tools, or `tool_choice: "none"`.
 */
export function toJsonSchemaToolRequest(
  request: CompletionRequest,
): JsonSchemaToolPlan | null {
  const tools = request.tools;
  if (!tools || tools.length === 0) return null;
  if (request.toolChoice === "none") return null;
  const forced = forcedToolName(request.toolChoice);
  const offered = normalizeToolSchemaBooleans(tools).filter((tool) => {
    const name = functionOf(tool)?.name;
    return typeof name === "string" && (forced === null || name === forced);
  });
  if (offered.length === 0) return null;
  const names = offered.map((tool) => functionOf(tool)!.name as string);
  // A forced or `required` choice must come back as a call, so the plain
  // answer branch is only offered under `auto` (and an absent choice).
  const allowAnswer =
    forced === null && request.toolChoice !== "required";
  const responseFormat = buildJsonSchemaToolFormat(offered, {
    allowAnswer,
    maxCalls: request.parallelToolCalls === false ? 1 : undefined,
  });
  const wireRequest: CompletionRequest = {
    ...request,
    prompt: `${request.prompt.trimEnd()}\n\n${jsonSchemaToolInstruction(names, allowAnswer)}`,
    responseFormat,
  };
  // No `tools` on the wire, and the flat prompt: a history of native
  // `tool_calls` messages without the `tools` they name is exactly what a
  // template that cannot render tools chokes on.
  delete wireRequest.tools;
  delete wireRequest.toolChoice;
  delete wireRequest.parallelToolCalls;
  delete wireRequest.messages;
  return { wireRequest, offeredNames: new Set(names) };
}

/** The `response_format` that admits exactly the reply shape above. */
export function buildJsonSchemaToolFormat(
  tools: ReadonlyArray<Record<string, unknown>>,
  opts: { allowAnswer: boolean; maxCalls?: number | undefined },
): ResponseFormatJsonSchema {
  const branches: Record<string, unknown>[] = [];
  for (const tool of tools) {
    const fn = functionOf(tool);
    if (!fn || typeof fn.name !== "string") continue;
    const parameters = asRecord(fn.parameters) ?? {
      type: "object",
      properties: {},
    };
    branches.push({
      type: "object",
      ...(typeof fn.description === "string" && fn.description.length > 0
        ? { description: fn.description }
        : {}),
      properties: {
        // `enum` of one rather than `const`: older schema-to-grammar
        // converters know `enum` and not `const`.
        name: { type: "string", enum: [fn.name] },
        arguments: parameters,
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    });
  }
  if (opts.allowAnswer) {
    branches.push({
      type: "object",
      description: "The final answer to the user, when no tool is needed.",
      properties: { answer: { type: "string", minLength: 1 } },
      required: ["answer"],
      additionalProperties: false,
    });
  }
  return {
    name: JSON_SCHEMA_TOOLS_FORMAT_NAME,
    description: "Tool calls for this step, or the final answer.",
    schema: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          minItems: 1,
          ...(opts.maxCalls !== undefined ? { maxItems: opts.maxCalls } : {}),
          items: { anyOf: branches },
        },
      },
      required: ["calls"],
      additionalProperties: false,
    },
  };
}

/**
 * The note appended to the prompt. The stable prefix tells the model to
 * use the native function-calling interface, which this request does not
 * have, so the note says plainly that it replaces that instruction.
 */
export function jsonSchemaToolInstruction(
  names: readonly string[],
  allowAnswer: boolean,
): string {
  return [
    "### reply-format",
    "This server cannot run native function calls, so this step calls tools through its JSON reply instead. This replaces the instruction to use the native function-calling interface.",
    'Reply with one JSON object and nothing else: {"calls": [ ... ]}.',
    `- A tool call is {"name": "<tool>", "arguments": { ... }}. Tools: ${names.join(", ")}.`,
    allowAnswer
      ? '- To answer the user without a tool, send exactly one item {"answer": "<your reply>"}.'
      : "- This step must call a tool.",
  ].join("\n");
}

/** What a schema-mode reply said: tool calls, a final answer, or neither. */
export type JsonSchemaToolReply =
  | { kind: "calls"; calls: OpenAiToolCall[] }
  | { kind: "answer"; text: string }
  | { kind: "unreadable" };

/**
 * Read a schema-mode reply. Lenient about the envelope (a bare array, a
 * single call object, `tool`/`args` spellings) because an engine that
 * ignores `response_format` still often writes close to it; strict about
 * truncation: JSON that only parses after closing an open string or
 * bracket was cut short and is not run.
 */
export function parseJsonSchemaToolReply(content: string): JsonSchemaToolReply {
  const value = parseJson(content);
  if (value === undefined) return { kind: "unreadable" };
  const items = Array.isArray(value)
    ? value
    : Array.isArray(asRecord(value)?.calls)
      ? (asRecord(value)!.calls as unknown[])
      : [value];
  const calls: OpenAiToolCall[] = [];
  const answers: string[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    if (typeof record.answer === "string") {
      if (record.answer.trim().length > 0) answers.push(record.answer);
      continue;
    }
    const name = typeof record.name === "string" ? record.name : record.tool;
    if (typeof name !== "string" || name.length === 0) continue;
    const args = record.arguments ?? record.args ?? {};
    calls.push({
      id: `json_schema_call_${calls.length}`,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    });
  }
  // A call wins over an answer written beside it: the answer is the
  // model's next step's job once the call's result is in.
  if (calls.length > 0) return { kind: "calls", calls };
  if (answers.length > 0) return { kind: "answer", text: answers.join("\n\n") };
  return { kind: "unreadable" };
}

/**
 * The completion a native-tools caller expects from a schema-mode one:
 * calls in `toolCalls` (content emptied), an answer as plain `content`.
 * An unreadable reply is returned as it came, so the step's own fallback
 * (a text call array, else the text as a reply) still applies.
 */
export function applyJsonSchemaToolReply(
  result: CompletionResult,
): CompletionResult {
  if (result.toolCalls && result.toolCalls.length > 0) return result;
  const reply = parseJsonSchemaToolReply(result.content);
  if (reply.kind === "calls") {
    return {
      ...result,
      content: "",
      toolCalls: reply.calls,
      finishReason: result.truncated ? result.finishReason : "tool_calls",
    };
  }
  if (reply.kind === "answer") return { ...result, content: reply.text };
  return result;
}

function parseJson(content: string): unknown {
  const text = content.trim();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const repaired = repairJsonText(text);
    if (!repaired || repaired.closedString || repaired.closedBrackets) {
      return undefined;
    }
    return repaired.value;
  }
}

function forcedToolName(choice: unknown): string | null {
  const record = asRecord(choice);
  const fn = asRecord(record?.function);
  return typeof fn?.name === "string" ? fn.name : null;
}

function functionOf(tool: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(tool.function);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
