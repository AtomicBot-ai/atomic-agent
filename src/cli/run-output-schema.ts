import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { assertSupportedJsonSchema } from "../llm/provider/openai/json-schema-support.js";
import { validateJsonSchemaValue } from "../llm/provider/openai/coerce-json-schema-value.js";
import type {
  StructuredAnswerInput,
  StructuredAnswerResult,
} from "../runtime/structured-answer.js";
import { parseJsonText } from "../tools/browser/extract-request.js";

/**
 * `run --output-schema` (ATO-2440; precedents `codex exec --output-schema`,
 * `claude -p --json-schema`): the run's final answer is JSON that matches
 * the caller's JSON Schema, or the run exits 3.
 *
 * 1. Each turn's message asks for the final reply as that JSON
 *    (`withSchemaInstruction`); the agent still works with every tool and
 *    every approval as usual.
 * 2. A last reply that already parses and matches is the answer.
 * 3. Otherwise one side call puts the reply into the schema, held to it
 *    by a grammar on a local model and by structured output on a cloud one
 *    (`runtime.shapeStructuredAnswer`), and its JSON is checked again.
 */

/** Exit code of a run whose final answer does not match `--output-schema`. */
export const SCHEMA_MISMATCH_EXIT_CODE = 3;

/** Largest schema accepted, like `browser.extract`'s cap. */
export const OUTPUT_SCHEMA_MAX_CHARS = 16_000;

type Schema = Record<string, unknown>;

/** The flag's value: inline JSON when it starts with `{`, else a file path. */
export function loadOutputSchema(value: string): Schema | { error: string } {
  const inline = value.trimStart().startsWith("{");
  let text: string;
  if (inline) {
    text = value;
  } else {
    try {
      text = readFileSync(resolve(value), "utf8");
    } catch {
      return { error: `--output-schema: cannot read ${resolve(value)}` };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `--output-schema: ${inline ? "the schema" : resolve(value)} is not valid JSON` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "--output-schema: a JSON Schema must be an object" };
  }
  const schema = parsed as Schema;
  if (JSON.stringify(schema).length > OUTPUT_SCHEMA_MAX_CHARS) {
    return { error: `--output-schema: the schema is too large (over ${OUTPUT_SCHEMA_MAX_CHARS} characters)` };
  }
  try {
    assertSupportedJsonSchema(schema);
  } catch (err) {
    return { error: `--output-schema: ${err instanceof Error ? err.message : String(err)}` };
  }
  return schema;
}

/** The message a turn gets: the person's text, then what the final reply must look like. */
export function withSchemaInstruction(message: string, schema: Schema): string {
  return [
    message,
    "",
    "When you reply with the final answer, the reply must be only a JSON value that matches this JSON Schema, with no other text and no code fence:",
    JSON.stringify(schema),
  ].join("\n");
}

/** Whether `value` matches `schema`; a schema the checker cannot read counts as no match. */
function matches(value: unknown, schema: Schema): boolean {
  try {
    return validateJsonSchemaValue(value, schema);
  } catch {
    return false;
  }
}

export type StructuredOutcome =
  | { ok: true; value: unknown; shaped: boolean }
  | { ok: false; error: string };

/**
 * Settle the run's final answer against the schema. `shape` is the
 * runtime's side call; absent (a runtime that has none) a reply that does
 * not match is the error.
 */
export async function settleStructuredAnswer(input: {
  reply: string | null;
  task: string;
  schema: Schema;
  sessionId: string;
  providerId?: string;
  signal?: AbortSignal;
  shape?: (input: StructuredAnswerInput) => Promise<StructuredAnswerResult>;
}): Promise<StructuredOutcome> {
  if (input.reply === null || input.reply.trim().length === 0) {
    return { ok: false, error: "the run ended without an answer" };
  }
  const direct = parseJsonText(input.reply);
  if (direct.ok && matches(direct.value, input.schema)) {
    return { ok: true, value: direct.value, shaped: false };
  }
  if (input.shape === undefined) {
    return { ok: false, error: direct.ok ? "the answer does not match the schema" : "the answer is not JSON" };
  }
  const shaped = await input.shape({
    task: input.task,
    answer: input.reply,
    schema: input.schema,
    sessionId: input.sessionId,
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  if (!shaped.ok) return { ok: false, error: `the answer could not be put into the schema: ${shaped.reason}` };
  if (!matches(shaped.value, input.schema)) {
    return { ok: false, error: "the answer does not match the schema" };
  }
  return { ok: true, value: shaped.value, shaped: true };
}
