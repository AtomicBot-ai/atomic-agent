import type { ReasoningFormat } from "../llm-provider.js";

export interface ReasoningExtractor {
  extractDelta(payload: Record<string, unknown>): string;
}

export function createReasoningExtractor(
  format: ReasoningFormat,
): ReasoningExtractor {
  switch (format) {
    case "delta_thinking":
      return {
        extractDelta: (payload) => {
          const delta = payload.delta as Record<string, unknown> | undefined;
          return typeof delta?.thinking === "string" ? delta.thinking : "";
        },
      };
    case "delta_reasoning_content":
      return {
        extractDelta: (payload) => {
          const delta = payload.delta as Record<string, unknown> | undefined;
          return typeof delta?.reasoning_content === "string"
            ? delta.reasoning_content
            : "";
        },
      };
    case "delta_reasoning":
      return {
        extractDelta: (payload) => {
          const delta = payload.delta as Record<string, unknown> | undefined;
          return typeof delta?.reasoning === "string" ? delta.reasoning : "";
        },
      };
    default:
      return { extractDelta: () => "" };
  }
}
