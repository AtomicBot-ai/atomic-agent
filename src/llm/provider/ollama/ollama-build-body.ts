import { getConfig } from "../../../config/index.js";
import type { CompletionRequest } from "../completion-types.js";

/**
 * Request body for Ollama's native `POST /api/chat`.
 *
 * Unlike the OpenAI-compatible path, the native API takes llama.cpp
 * sampling knobs directly (`top_k`, `repeat_penalty`, `repeat_last_n`),
 * so nothing from the request needs to be stripped. All sampling
 * parameters live in a flat `options` object next to `num_ctx`.
 *
 * `tools` pass through unchanged: Ollama's native tool schema is the
 * OpenAI function shape (`{ type, function: { name, description,
 * parameters } }`), which is exactly what the agent loop already sends.
 *
 * `format` carries the raw JSON Schema for structured outputs. It is
 * never combined with `tools` — same reasoning as the OpenAI body
 * builder: a tool call's `parameters` schema is already the contract.
 */
export function buildOllamaChatBody(
  request: CompletionRequest,
  defaultChatModel: string,
  stream: boolean,
  numCtx: number | undefined,
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    temperature: request.temperature ?? 0.2,
    num_predict:
      request.maxTokens ?? getConfig().localModels.completionMaxTokens,
  };
  if (typeof numCtx === "number") options.num_ctx = numCtx;
  if (typeof request.topP === "number") options.top_p = request.topP;
  if (typeof request.topK === "number") options.top_k = request.topK;
  if (typeof request.seed === "number") options.seed = request.seed;
  if (typeof request.repeatPenalty === "number") {
    options.repeat_penalty = request.repeatPenalty;
  }
  if (typeof request.repeatLastN === "number") {
    options.repeat_last_n = request.repeatLastN;
  }
  if (request.stop && request.stop.length > 0) options.stop = request.stop;

  const body: Record<string, unknown> = {
    model: defaultChatModel,
    messages: [{ role: "user", content: request.prompt }],
    stream,
    options,
  };
  const hasTools = Boolean(request.tools && request.tools.length > 0);
  if (hasTools) {
    body.tools = request.tools;
  }
  if (request.responseFormat && !hasTools) {
    body.format = request.responseFormat.schema;
  }
  return body;
}
