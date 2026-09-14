import type { ReasoningFormat } from "../llm-provider.js";

export interface ReasoningExtractor {
  /** Reasoning text carried by one streamed `{ delta }` event. */
  extractDelta(payload: Record<string, unknown>): string;
  /** Reasoning text carried by a unary `choices[0].message`. */
  extractFromMessage(message: Record<string, unknown>): string;
}

/**
 * The reasoning fields OpenAI-compatible services have settled on, in the
 * order `auto` consults them. A message never legitimately carries two of
 * them, so the first non-empty one wins.
 */
const REASONING_FIELDS: readonly string[] = [
  "reasoning",
  "reasoning_content",
  "thinking",
];

function fieldFor(format: ReasoningFormat): readonly string[] {
  switch (format) {
    case "delta_thinking":
      return ["thinking"];
    case "delta_reasoning_content":
      return ["reasoning_content"];
    case "delta_reasoning":
      return ["reasoning"];
    case "auto":
      return REASONING_FIELDS;
    default:
      return [];
  }
}

function firstString(
  record: Record<string, unknown> | undefined,
  fields: readonly string[],
): string {
  if (!record) return "";
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

export function createReasoningExtractor(
  format: ReasoningFormat,
): ReasoningExtractor {
  const fields = fieldFor(format);
  return {
    extractDelta: (payload) =>
      firstString(
        payload.delta as Record<string, unknown> | undefined,
        fields,
      ),
    extractFromMessage: (message) => firstString(message, fields),
  };
}
