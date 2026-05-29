import type { ResponseFormatJsonSchema } from "../../llm/provider/completion-types.js";
import { LINK_KINDS } from "./link-store.js";

/**
 * Memory-v2 phase 2 — cloud-provider variant of `LINK_GENERATOR_GRAMMAR`.
 *
 * Cloud providers (OpenAI, OpenRouter, aimlapi) do not understand GBNF.
 * The runtime sends this Structured Outputs schema instead so the model
 * is forced to emit valid JSON that the parser can ingest directly. The
 * `kind` enum mirrors `LINK_KINDS` exactly — adding a new link kind
 * requires updating both this schema and `LINK_GENERATOR_GRAMMAR`.
 *
 * Shape (`strict: true` is enforced at the adapter level):
 *
 *   { "kind": "none" }
 *   { "kind": "links",
 *     "links": [
 *       { "from_id": 12, "to_id": 17, "link_kind": "RELATES_TO" },
 *       ...
 *     ] }
 *
 * The discriminated union keeps the abstain path explicit so the
 * parser never has to guess whether an empty array means "no relations"
 * or "format failure".
 */
export const LINK_GENERATOR_RESPONSE_FORMAT: ResponseFormatJsonSchema = {
  name: "link_generator_v1",
  description:
    "Emit zero or more directed memory-link triples between candidate ids. " +
    "Use the `none` discriminator when no genuine relation exists.",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["none", "links"] },
      links: {
        type: "array",
        // The runtime caps further at parse time via `maxLinks`. The
        // schema cap is a hard ceiling so a runaway model cannot
        // hand the provider a megabyte of triples.
        maxItems: 16,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            from_id: { type: "integer", minimum: 1 },
            to_id: { type: "integer", minimum: 1 },
            link_kind: {
              type: "string",
              enum: [...LINK_KINDS],
            },
          },
          required: ["from_id", "to_id", "link_kind"],
        },
      },
    },
    required: ["kind"],
  },
};
