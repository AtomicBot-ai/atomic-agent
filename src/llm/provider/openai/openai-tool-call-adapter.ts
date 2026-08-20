import type { ToolDescriptor } from "../../../prompt/stable-prefix.js";
import {
  type ToolCallBatch,
  type ToolCallPayload,
} from "../../grammar/tool-call-grammar.js";
import type { OpenAiToolCall } from "../completion-types.js";
import type { ToolCallAdapter } from "../adapters/tool-call-adapter.js";

const REPLY_TOOL = "reply";
const FINISH_TOOL = "finish";

/**
 * OpenAI function names must match `^[a-zA-Z0-9_-]{1,64}$` — dots are
 * forbidden. We escape qualified names with double underscores.
 */
export function nameEscape(qualifiedName: string): string {
  return qualifiedName.replace(/\./g, "__");
}

export function nameUnescape(providerName: string): string {
  return providerName.replace(/__/g, ".");
}

function replyFinishDescriptors(): ToolDescriptor[] {
  return [
    {
      name: REPLY_TOOL,
      tier: "frequent",
      summary: "End the turn with a user-visible reply.",
      argsSchema: "text: string (required)",
    },
    {
      name: FINISH_TOOL,
      tier: "frequent",
      summary: "End the entire session.",
      argsSchema: "text: string (optional)",
    },
  ];
}

function descriptorToJsonSchema(descriptor: ToolDescriptor): Record<string, unknown> {
  if (descriptor.name === REPLY_TOOL) {
    return {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description: "User-visible reply text. Must be non-empty.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    };
  }
  if (descriptor.name === FINISH_TOOL) {
    return {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Optional final user-visible text.",
        },
      },
      additionalProperties: false,
    };
  }
  if (descriptor.argsJsonSchema) {
    return descriptor.argsJsonSchema;
  }
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

export function descriptorsToOpenAiTools(
  descriptors: readonly ToolDescriptor[],
): ReadonlyArray<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  const all = [...descriptors, ...replyFinishDescriptors()];
  for (const d of all) {
    const escaped = nameEscape(d.name);
    if (seen.has(escaped)) continue;
    seen.add(escaped);
    out.push({
      type: "function",
      function: {
        name: escaped,
        description: `${d.summary}\nArgs: ${d.argsSchema}`,
        parameters: descriptorToJsonSchema(d),
      },
    });
  }
  return out;
}

/**
 * A tool call's `function.arguments` was non-empty but not valid JSON (or
 * not a JSON object). Thrown rather than silently substituting `{}` so the
 * failure reaches `tryParseToolCalls`'s existing catch block and routes
 * through the same one-shot repair path grammar-parsed batches already
 * use — never include the raw arguments here, they may carry sensitive
 * user data and this message can reach logs.
 */
export class ToolCallArgumentsParseError extends Error {
  constructor(toolName: string) {
    super(`tool call "${toolName}" arguments are not a valid JSON object`);
    this.name = "ToolCallArgumentsParseError";
  }
}

/**
 * Parses one tool call's raw argument string. A genuinely empty/whitespace
 * string is a legitimate zero-arg call and maps to `{}`. Anything
 * non-empty that fails to parse, or parses to something other than a JSON
 * object, throws instead of falling back to `{}` — a truncated or
 * malformed argument string must never be silently treated the same as an
 * intentional empty call.
 */
function parseArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new SyntaxError("tool call arguments must be a JSON object");
}

export function openAiToolCallsToBatch(
  toolCalls: ReadonlyArray<OpenAiToolCall>,
  reasoningText?: string,
): ToolCallBatch {
  const calls: ToolCallPayload[] = [];
  for (const tc of toolCalls) {
    const name = nameUnescape(tc.function.name);
    let args: Record<string, unknown>;
    try {
      args = parseArguments(tc.function.arguments);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new ToolCallArgumentsParseError(name);
      }
      throw err;
    }
    calls.push({
      tool: name,
      args,
      ...(reasoningText ? { reasoning: reasoningText } : {}),
    });
  }
  const reasoning =
    reasoningText && reasoningText.length > 0 ? reasoningText : undefined;
  if (calls.length === 0) {
    return { kind: "batch", calls: [], reasoning };
  }
  if (calls.length === 1) {
    return { kind: "batch", calls, reasoning };
  }
  return { kind: "batch", calls, reasoning };
}

export const openAiToolCallAdapter: ToolCallAdapter = {
  nameEscape,
  nameUnescape,
  descriptorsToTools: descriptorsToOpenAiTools,
  toolCallsToBatch: openAiToolCallsToBatch,
};
