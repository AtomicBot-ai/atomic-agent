import type { ResponseFormatJsonSchema } from "../../llm/provider/completion-types.js";

/**
 * ATO-672. Structured Outputs twin of `NOTE_RECONCILE_GRAMMAR` for cloud
 * providers. Every key is required on every branch (OpenAI strict mode
 * refuses optional keys); the abstain branch carries an empty array.
 *
 *   { "kind": "none", "decisions": [] }
 *   { "kind": "decisions", "decisions": [{ "action": "SUPERSEDE", "id": 12 }] }
 */
export const NOTE_RECONCILE_RESPONSE_FORMAT: ResponseFormatJsonSchema = {
  name: "note_reconcile_v1",
  description:
    "Decide whether a new memory note makes older notes outdated " +
    "(SUPERSEDE) or only repeats one (DUPLICATE). Use `none` with an " +
    "empty `decisions` array when every note can stay.",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["none", "decisions"] },
      decisions: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["SUPERSEDE", "DUPLICATE"] },
            id: { type: "integer", minimum: 1 },
          },
          required: ["action", "id"],
        },
      },
    },
    required: ["kind", "decisions"],
  },
};
