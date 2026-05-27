import type { CompletionRequest } from "./completion-types.js";
import type { ToolCallTransport } from "./completion-types.js";

/**
 * Build a cloud sub-call completion request with a single synthetic
 * `emit_*` function and `tool_choice: "auto"`.
 *
 * The legacy contract pinned `tool_choice` to the explicit `{ type:
 * "function", function: { name } }` object form so the model would be
 * forced to call that exact tool. Production deployments against
 * Qwen-thinking via OpenRouter reject the object form (and the equivalent
 * `"required"` literal) with `400 InvalidParameter` — Alibaba's gate does
 * not allow forcing tool_choice while the model is in thinking mode.
 *
 * With `"auto"` the model still only sees one tool, so picking it is
 * effectively the only useful choice. When a thinking model decides to
 * answer in plain text instead, every sub-call's parser already falls
 * back from `tool_calls[0].arguments` to `completion.content`
 * (`extractCloudSubcallText` in `reflection-runner.ts` is the canonical
 * example) so the sub-call still extracts useful output.
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
    toolChoice: "auto",
    parallelToolCalls: false,
  };
}

export function isCloudSubcallTransport(
  transport: ToolCallTransport,
): boolean {
  return transport === "native_tools";
}
