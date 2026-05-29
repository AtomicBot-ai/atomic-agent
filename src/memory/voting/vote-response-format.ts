import type { ResponseFormatJsonSchema } from "../../llm/provider/completion-types.js";

/**
 * Memory-v2 phase 7a — cloud-provider variant of `VOTE_GRAMMAR`.
 *
 * Cloud providers (OpenAI, OpenRouter, aimlapi) do not understand
 * GBNF. The runtime sends this Structured Outputs schema instead so
 * the model is forced to emit valid JSON that the parser can ingest
 * directly. The `kind` enum mirrors `VoteKind` (memory / lesson /
 * profile / procedure) and `direction` is the signed scalar that
 * `VoteStore.applyVote` consumes verbatim.
 *
 * Shape (`strict: true` is enforced at the adapter level):
 *
 *   { "kind": "none" }
 *   { "kind": "votes",
 *     "votes": [
 *       { "target_kind": "memory", "target_id": 42, "direction": 1 },
 *       { "target_kind": "lesson", "target_id": 7,  "direction": -1 },
 *       ...
 *     ] }
 *
 * The discriminated `kind` field keeps the abstain path explicit and
 * lets the parser short-circuit without scanning an empty array.
 *
 * `maxItems: 16` is a hard ceiling well above the runtime-side
 * `maxVotesPerCall` cap (default 8) — it exists only to keep a
 * runaway completion from streaming megabytes of votes back through
 * the provider.
 */
export const VOTE_RESPONSE_FORMAT: ResponseFormatJsonSchema = {
  name: "vote_runner_v1",
  description:
    "Emit zero or more up/down votes against ids surfaced this turn. " +
    "Use the `none` discriminator when no surfaced item is worth voting on.",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["none", "votes"] },
      votes: {
        type: "array",
        maxItems: 16,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            target_kind: {
              type: "string",
              enum: ["memory", "lesson", "profile", "procedure"],
            },
            target_id: { type: "integer", minimum: 1 },
            direction: { type: "integer", enum: [1, -1] },
          },
          required: ["target_kind", "target_id", "direction"],
        },
      },
    },
    required: ["kind"],
  },
};
