import type { ResponseFormatJsonSchema } from "../../llm/provider/completion-types.js";

import { REWRITTEN_QUERY_MAX_LENGTH } from "./query-rewriter-parser.js";

/**
 * v2.5 query rewriter (Phase A) — cloud-provider variant of
 * `QUERY_REWRITER_GRAMMAR`.
 *
 * Cloud providers (OpenAI, OpenRouter, aimlapi) do not understand
 * GBNF. The runtime sends this Structured Outputs schema instead so
 * the model is forced to emit valid JSON the parser can ingest
 * directly.
 *
 * Shape (`strict: true` is enforced at the adapter level):
 *
 *   { "rewritten_query": "did Tony mention the dental implant?" }
 *
 * The abstain branch is expressed via the literal token `NONE` in
 * the string field — same contract as the GBNF path (the parser
 * treats `"NONE"` identically to a missing envelope and falls back
 * to the raw user message). We deliberately do not model abstain as
 * `null` here: `strict: true` rejects unions with null on most
 * vendors, and a literal-string sentinel keeps the schema flat.
 */
export const QUERY_REWRITER_RESPONSE_FORMAT: ResponseFormatJsonSchema = {
  name: "query_rewriter_v1",
  description:
    "Rewrite the latest ambiguous user message into a self-contained " +
    "search query. Use the literal token \"NONE\" when no rewrite is possible.",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      rewritten_query: {
        type: "string",
        maxLength: REWRITTEN_QUERY_MAX_LENGTH,
      },
    },
    required: ["rewritten_query"],
  },
};
