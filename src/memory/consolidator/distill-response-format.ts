import type { ResponseFormatJsonSchema } from "../../llm/provider/completion-types.js";

import {
  LESSON_ACTIVATION_MAX_LENGTH,
  LESSON_MAX_TAGS,
  LESSON_PRINCIPLE_MAX_LENGTH,
  LESSON_TAG_MAX_LENGTH,
} from "../lessons/lesson-store.js";
import {
  PROCEDURE_ACTIVATION_MAX_LENGTH,
  PROCEDURE_DESCRIPTION_MAX_LENGTH,
  PROCEDURE_MAX_STEPS,
  PROCEDURE_MAX_TAGS,
  PROCEDURE_MIN_STEPS,
  PROCEDURE_TOOL_HINT_MAX_LENGTH,
} from "../procedures/procedure-store.js";

/**
 * Memory-v2 phase 5 — cloud-provider variant of `DISTILL_GRAMMAR`.
 *
 * Cloud providers (OpenAI, OpenRouter, aimlapi) do not understand GBNF.
 * The runtime sends this Structured Outputs schema instead so the model
 * is forced to emit valid JSON that the parser can ingest directly.
 *
 * Shape (`strict: true` is enforced at the adapter level):
 *
 *   { "kind": "none" }
 *   { "kind": "lesson",
 *     "activation": "...",
 *     "principle": "...",
 *     "tags": ["foo", "bar"] }
 *
 * Tags array is **always required** (Structured Outputs forbids
 * conditionally-required fields when `strict: true`). The runtime
 * caller / `parseDistillOutput` accept an empty `tags` array as
 * "no tags", which matches the optional `; tags=...` GBNF clause.
 */
export const DISTILL_RESPONSE_FORMAT: ResponseFormatJsonSchema = {
  name: "distill_lesson_v1",
  description:
    "Distill a memory cluster into one lesson. Use the `none` " +
    "discriminator when no durable advice can be extracted.",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["none", "lesson"] },
      activation: { type: "string", maxLength: LESSON_ACTIVATION_MAX_LENGTH },
      principle: { type: "string", maxLength: LESSON_PRINCIPLE_MAX_LENGTH },
      tags: {
        type: "array",
        maxItems: LESSON_MAX_TAGS,
        items: { type: "string", maxLength: LESSON_TAG_MAX_LENGTH },
      },
    },
    required: ["kind", "activation", "principle", "tags"],
  },
};

/**
 * Memory-v2 phase 7b — cloud-provider variant of
 * `DISTILL_WITH_PROCEDURE_GRAMMAR`.
 *
 * Single LLM call emits a `LESSON` block plus an optional `PROCEDURE`
 * block (cross-phase invariant 21: still ONE inference per cluster).
 *
 * Shape:
 *
 *   { "kind": "none" }
 *   { "kind": "lesson",
 *     "activation": "...",
 *     "principle": "...",
 *     "tags": [...],
 *     "procedure": null }
 *   { "kind": "lesson",
 *     "activation": "...",
 *     "principle": "...",
 *     "tags": [...],
 *     "procedure": {
 *       "activation": "...",
 *       "steps": [
 *         { "description": "...", "tool_hint": "os.fs.read" | null },
 *         ...
 *       ],
 *       "tags": [...]
 *     } }
 *
 * `procedure` is **always required** as a key (Structured Outputs
 * forbids conditional requireds with `strict: true`), but its value
 * may be `null` when the model has no procedure to add. The parser
 * fallback maps `null` to "no procedure", matching the optional
 * `PROCEDURE` line in the GBNF path.
 *
 * `tool_hint` inside each step is similarly always required, with
 * `null` meaning "no tool hint" — matches the `@toolhint?` suffix.
 */
export const DISTILL_WITH_PROCEDURE_RESPONSE_FORMAT: ResponseFormatJsonSchema = {
  name: "distill_lesson_and_procedure_v1",
  description:
    "Distill a memory cluster into one lesson plus an optional " +
    "procedure. Use `kind=none` when nothing durable can be extracted; " +
    "use `procedure=null` when only a lesson applies.",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["none", "lesson"] },
      activation: { type: "string", maxLength: LESSON_ACTIVATION_MAX_LENGTH },
      principle: { type: "string", maxLength: LESSON_PRINCIPLE_MAX_LENGTH },
      tags: {
        type: "array",
        maxItems: LESSON_MAX_TAGS,
        items: { type: "string", maxLength: LESSON_TAG_MAX_LENGTH },
      },
      procedure: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              activation: {
                type: "string",
                maxLength: PROCEDURE_ACTIVATION_MAX_LENGTH,
              },
              steps: {
                type: "array",
                minItems: PROCEDURE_MIN_STEPS,
                maxItems: PROCEDURE_MAX_STEPS,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    description: {
                      type: "string",
                      maxLength: PROCEDURE_DESCRIPTION_MAX_LENGTH,
                    },
                    tool_hint: {
                      anyOf: [
                        { type: "null" },
                        {
                          type: "string",
                          maxLength: PROCEDURE_TOOL_HINT_MAX_LENGTH,
                        },
                      ],
                    },
                  },
                  required: ["description", "tool_hint"],
                },
              },
              tags: {
                type: "array",
                maxItems: PROCEDURE_MAX_TAGS,
                items: { type: "string", maxLength: LESSON_TAG_MAX_LENGTH },
              },
            },
            required: ["activation", "steps", "tags"],
          },
        ],
      },
    },
    required: ["kind", "activation", "principle", "tags", "procedure"],
  },
};
