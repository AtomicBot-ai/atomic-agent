import { jsonSchemaToGbnf } from "../llm/grammar/json-schema-gbnf.js";
import type {
  BrowserExtractCompletionParams,
  BrowserExtractModel,
} from "../tools/browser/extract-request.js";
import { emitSchemaFor, readExtractedJson } from "../tools/browser/extract-request.js";

/**
 * `run --output-schema` (ATO-2440): one side call that puts a finished
 * answer into the caller's JSON Schema, when the reply the agent wrote
 * does not already match it. The constraint is the one `browser.extract`
 * uses (ATO-699): GBNF built from the schema on a grammar (local) link,
 * so the sampler can only write the schema's shape, and a one-function
 * schema (the provider's structured output) on a native-tools link.
 *
 * It is not a turn: no tools, nothing written to the session, its own
 * fallback partition so a refusal here never moves the chat's link. The
 * caller validates what comes back against the full schema.
 */

type Schema = Record<string, unknown>;

/** Fallback partition, like `browser-extract:` / `enhance:`. */
export const STRUCTURED_ANSWER_SESSION_PREFIX = "structured-answer:";

export const STRUCTURED_ANSWER_EMIT_FUNCTION = "emit_answer";

/** Output bound for the JSON, on either transport. */
export const STRUCTURED_ANSWER_MAX_TOKENS = 8192;

export const STRUCTURED_ANSWER_TIMEOUT_MS = 180_000;

/** The longest answer and task text sent; past it the text is cut. */
const MAX_ANSWER_CHARS = 48_000;
const MAX_TASK_CHARS = 8_000;

const SYSTEM =
  "You turn a finished answer into JSON that matches a given JSON Schema. You answer with the JSON only.";

export interface StructuredAnswerInput {
  /** What the person asked, for context. */
  task: string;
  /** The agent's last reply. */
  answer: string;
  schema: Schema;
  /** The chat, for the partition key. */
  sessionId: string;
  /** `run --model`'s provider, so the side call uses the same link. */
  providerId?: string;
  signal?: AbortSignal;
}

export type StructuredAnswerResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut at ${max} characters]` : text;
}

export function buildStructuredAnswerPrompt(input: Pick<StructuredAnswerInput, "task" | "answer" | "schema">): string {
  return [
    "Write the answer below as JSON that matches this JSON Schema:",
    JSON.stringify(input.schema),
    "",
    "Rules:",
    "- Use only what the answer says. Never invent a value; leave an optional field out, or use null where the schema allows it, when the answer does not say.",
    "- Keep the answer's facts, numbers and names exactly.",
    "",
    "The task the answer is for:",
    clip(input.task, MAX_TASK_CHARS),
    "",
    "The answer:",
    clip(input.answer, MAX_ANSWER_CHARS),
    "",
    "Answer with the JSON only.",
  ].join("\n");
}

export function buildStructuredAnswerRequest(
  input: StructuredAnswerInput,
  model: Pick<BrowserExtractModel, "transport" | "slotId" | "serverTemplate">,
  signal: AbortSignal,
): { request: BrowserExtractCompletionParams; wrapped: boolean } {
  const prompt = buildStructuredAnswerPrompt(input);
  const common = {
    prompt,
    sessionId: `${STRUCTURED_ANSWER_SESSION_PREFIX}${input.sessionId}`,
    temperature: 0,
    disableThinking: true,
    maxTokens: STRUCTURED_ANSWER_MAX_TOKENS,
    signal,
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
  };
  if (model.transport(input.providerId) === "native_tools") {
    const { parameters, wrapped } = emitSchemaFor(input.schema);
    return {
      wrapped,
      request: {
        ...common,
        grammar: "",
        slotId: -1,
        tools: [
          {
            type: "function",
            function: { name: STRUCTURED_ANSWER_EMIT_FUNCTION, description: "Emit the answer as JSON", parameters },
          },
        ],
        toolChoice: "auto",
        parallelToolCalls: false,
      },
    };
  }
  return {
    wrapped: false,
    request: {
      ...common,
      // Throws `JsonSchemaGbnfError` for a schema too large for a grammar.
      grammar: jsonSchemaToGbnf(input.schema),
      slotId: model.slotId(),
      cachePrompt: false,
      ...((model.serverTemplate?.() ?? true)
        ? { chat: { system: SYSTEM, user: prompt, prefixHash: "structured-answer", enableThinking: false } }
        : {}),
    },
  };
}

/** Never throws: a failure is a reason the caller reports as the schema error. */
export async function shapeStructuredAnswer(
  input: StructuredAnswerInput,
  model: BrowserExtractModel | undefined,
): Promise<StructuredAnswerResult> {
  if (model === undefined) return { ok: false, reason: "no model is available to shape the answer" };
  const timeout = AbortSignal.timeout(STRUCTURED_ANSWER_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    const built = buildStructuredAnswerRequest(input, model, signal);
    const completion = await model.complete(built.request);
    const parsed = readExtractedJson(completion, built.wrapped);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, reason: "the model did not answer with JSON" };
  } catch (err) {
    if (signal.aborted) return { ok: false, reason: timeout.aborted ? "timed out" : "cancelled" };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
