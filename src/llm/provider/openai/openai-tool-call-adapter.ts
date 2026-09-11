import type { ToolDescriptor } from "../../../prompt/stable-prefix.js";
import {
  type ToolCallBatch,
  type ToolCallPayload,
} from "../../grammar/tool-call-grammar.js";
import type { OpenAiToolCall } from "../completion-types.js";
import type {
  ToolCallAdapter,
  ToolBatchOptions,
  ToolDefinitionOptions,
} from "../adapters/tool-call-adapter.js";
import {
  strictWidenedProperties,
  toStrictJsonSchema,
} from "./strict-tool-schema.js";
import { withoutTopLevelNullArgs } from "./openai-strict-tools.js";

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
      argsSchema:
        "text: string (required), attachments: string[] (optional — paths of existing files to deliver with the reply)",
    },
    {
      name: FINISH_TOOL,
      tier: "frequent",
      summary: "End the entire session.",
      argsSchema: "text: string (optional)",
    },
  ];
}

function descriptorToJsonSchema(
  descriptor: ToolDescriptor,
): Record<string, unknown> {
  if (descriptor.name === REPLY_TOOL) {
    return {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description: "User-visible reply text. Must be non-empty.",
        },
        attachments: {
          type: "array",
          items: { type: "string" },
          description:
            "Paths of existing files to deliver with the reply (sent as files on Telegram/Discord).",
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

interface BuiltFunctions {
  tools: ReadonlyArray<Record<string, unknown>>;
  /**
   * Escaped function name -> the arguments whose optionality the strict
   * rewrite erased. Only the functions that actually came out `strict`
   * appear, and a function whose properties were all already required
   * maps to an empty set.
   */
  widenedArgs: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * The one pass both directions read: the emitted function definitions
 * and, alongside them, the per-function record of what the rewrite
 * changed. Keeping them in one place is what makes the null-drop on the
 * way back in exactly as narrow as the conversion on the way out — see
 * `openAiToolCallsToBatch`.
 */
function buildFunctions(
  descriptors: readonly ToolDescriptor[],
  options?: ToolDefinitionOptions,
): BuiltFunctions {
  const seen = new Set<string>();
  const widenedArgs = new Map<string, ReadonlySet<string>>();
  const out: Record<string, unknown>[] = [];
  const all = [...descriptors, ...replyFinishDescriptors()];
  for (const d of all) {
    const escaped = nameEscape(d.name);
    if (seen.has(escaped)) continue;
    seen.add(escaped);
    const parameters = descriptorToJsonSchema(d);
    const strict = options?.strict ? toStrictJsonSchema(parameters) : null;
    if (strict) widenedArgs.set(escaped, strictWidenedProperties(parameters));
    out.push({
      type: "function",
      function: {
        name: escaped,
        description: `${d.summary}\nArgs: ${d.argsSchema}`,
        ...(strict ? { parameters: strict, strict: true } : { parameters }),
      },
    });
  }
  return { tools: out, widenedArgs };
}

/**
 * Both directions of one inference ask for the same build: the request
 * builder for `tools`, the tool-call parser for what got widened. A
 * one-entry memo keyed on the descriptor array's identity and the
 * strict flag turns the second into a lookup instead of a full
 * re-conversion of every registered schema.
 *
 * Identity is a sound key here because a descriptor array is REBUILT,
 * never edited: `rebuildToolDescriptorsFromMcp` assigns a fresh array
 * (of fresh descriptor objects) whenever the catalog changes, and the
 * step executor's `terminalOnly` narrowing is a `filter`. A reference
 * that compares equal therefore describes the same tools.
 *
 * Deliberately a single slot: the two calls are adjacent within a step,
 * nothing needs to survive past them, and holding descriptor arrays
 * alive is not worth a cache.
 */
let lastBuild:
  | {
      descriptors: readonly ToolDescriptor[];
      strict: boolean;
      built: BuiltFunctions;
    }
  | undefined;

function buildFunctionsMemo(
  descriptors: readonly ToolDescriptor[],
  options?: ToolDefinitionOptions,
): BuiltFunctions {
  const strict = options?.strict === true;
  if (
    lastBuild &&
    lastBuild.descriptors === descriptors &&
    lastBuild.strict === strict
  ) {
    return lastBuild.built;
  }
  const built = buildFunctions(descriptors, options);
  lastBuild = { descriptors, strict, built };
  return built;
}

/**
 * `options.strict` is the `supportsTools: "strict"` model level reaching
 * the wire. It is a request, not an instruction: each function is marked
 * `strict` only when `toStrictJsonSchema` could rewrite its parameters
 * faithfully, and the ones it refuses (an open-object fallback schema, a
 * typed open map, a `$ref`) ship exactly as they do with the flag off.
 * A mixed array is legal; a whole-array flag would turn one
 * unconvertible tool into a 400 on every request.
 *
 * A caller that puts this array in a request must also read
 * `hasStrictFunctionTools` off it: strict decoding and parallel function
 * calls do not compose, so a request carrying a strict function sends
 * `parallel_tool_calls: false`. See `buildLlmStreamParams`.
 */
export function descriptorsToOpenAiTools(
  descriptors: readonly ToolDescriptor[],
  options?: ToolDefinitionOptions,
): ReadonlyArray<Record<string, unknown>> {
  return buildFunctionsMemo(descriptors, options).tools;
}

/**
 * What `descriptorsToOpenAiTools` actually CHANGED, for the same
 * descriptors and options: each function it marked strict, mapped to
 * the arguments whose optionality the rewrite erased. The caller hands
 * this back to `openAiToolCallsToBatch`, which is then able to undo the
 * rewrite exactly where it happened and nowhere else.
 *
 * Escaped names, deliberately: `nameUnescape` cannot round-trip a tool
 * whose own name contains an underscore, and these keys have to match
 * the wire exactly.
 */
export function strictOpenAiWidenedArgs(
  descriptors: readonly ToolDescriptor[],
  options?: ToolDefinitionOptions,
): ReadonlyMap<string, ReadonlySet<string>> {
  if (!options?.strict) return EMPTY_WIDENED;
  return buildFunctionsMemo(descriptors, options).widenedArgs;
}

const EMPTY_WIDENED: ReadonlyMap<string, ReadonlySet<string>> = new Map<
  string,
  ReadonlySet<string>
>();

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

/**
 * Under a strict schema an unset optional argument is not an absent key
 * — the schema forced it into `required` as a `null` union, so that is
 * what the model sends. Dropping those top-level nulls restores the
 * shape every tool's validator was written against; several read their
 * raw args with `!== undefined` (`memory.profile.set.pinned`,
 * `memory.notes.recall.id`, `os.git.init.userName`) and would take a
 * branch on a literal `null` that an omitted key never triggers.
 *
 * Applied only to the arguments we actually widened — see
 * `options.strictWidenedArgs`. Two things are therefore left alone, and
 * both matter:
 *
 *   * every argument of a tool whose schema was REFUSED. That function
 *     went out byte-identical to the flag-off payload, so a `null` in
 *     it is a `null` the model chose to send;
 *   * an argument of a CONVERTED tool that was already `required`. It
 *     too was emitted byte-identical — the converter only widens what
 *     it moves — so if it is also nullable (`z.string().nullable()`
 *     through the MCP SDK; `["string", "null"]` listed in `required`)
 *     the model means the null literally, and deleting the key would
 *     hand its server a call missing a required field.
 *
 * Top level only, and deliberately so: no schema we convert has a
 * nested object today, while `null` deeper inside an argument is data
 * the model meant to send (a JSON body, an MCP server's own payload)
 * and is not ours to rewrite.
 *
 * That first clause is a premise, not an observation, and it is shared
 * with `indexOfferedTools`, whose strict narrowing walks the top-level
 * `required` and nothing else. So it is pinned over the real emitted
 * payload ("emits no nested object inside a function it marked strict",
 * in this module's test): a built-in whose strict form nests an object
 * has to teach BOTH walks to recurse, in the same change.
 */
function dropNullArgs(
  args: Record<string, unknown>,
  widened: ReadonlySet<string>,
): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(args)) {
    if (value !== null || !widened.has(key)) continue;
    out ??= { ...args };
    delete out[key];
  }
  return out ?? args;
}

export function openAiToolCallsToBatch(
  toolCalls: ReadonlyArray<OpenAiToolCall>,
  reasoningText?: string,
  options?: ToolBatchOptions,
): ToolCallBatch {
  const calls: ToolCallPayload[] = [];
  for (const tc of toolCalls) {
    const name = nameUnescape(tc.function.name);
    let args: Record<string, unknown>;
    try {
      args = parseArguments(tc.function.arguments);
      const widened = options?.strictWidenedArgs?.get(tc.function.name);
      if (widened && widened.size > 0) {
        args = dropNullArgs(args, widened);
      }
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

/**
 * Wraps an adapter so parsed calls lose their top-level `null`
 * arguments — the shape a model produces once strict mode has forced
 * every optional parameter into `required` as a nullable. Applied only
 * on providers that opted into `strictTools`, so nothing changes for
 * anyone else. See `withoutTopLevelNullArgs`.
 */
export function withStrictNullArgumentDrop(
  adapter: ToolCallAdapter,
): ToolCallAdapter {
  return {
    ...adapter,
    toolCallsToBatch: (toolCalls, reasoningText) => {
      const batch = adapter.toolCallsToBatch(toolCalls, reasoningText);
      return {
        ...batch,
        calls: batch.calls.map((call) => {
          const args = withoutTopLevelNullArgs(call.args);
          return args === call.args ? call : { ...call, args };
        }),
      };
    },
  };
}

export const openAiToolCallAdapter: ToolCallAdapter = {
  nameEscape,
  nameUnescape,
  descriptorsToTools: descriptorsToOpenAiTools,
  strictWidenedArgs: strictOpenAiWidenedArgs,
  toolCallsToBatch: openAiToolCallsToBatch,
};
