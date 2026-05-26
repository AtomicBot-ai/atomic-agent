import type { CompletionRequest } from "./completion-types.js";
import type { ToolCallTransport } from "./completion-types.js";

/**
 * Build a cloud sub-call completion request with a single synthetic
 * `emit_*` function and `tool_choice: required`.
 */
export function buildCloudSubcallRequest(params: {
  prompt: string;
  emitFunctionName: string;
  argsSchema: Record<string, unknown>;
  description?: string;
  sessionId?: string;
  maxTokens?: number;
}): CompletionRequest {
  return {
    prompt: params.prompt,
    sessionId: params.sessionId,
    maxTokens: params.maxTokens,
    tools: [
      {
        type: "function",
        function: {
          name: params.emitFunctionName,
          description: params.description ?? "Emit structured output",
          parameters: params.argsSchema,
        },
      },
    ],
    toolChoice: {
      type: "function",
      function: { name: params.emitFunctionName },
    },
    parallelToolCalls: false,
  };
}

export function isCloudSubcallTransport(
  transport: ToolCallTransport,
): boolean {
  return transport === "native_tools";
}
