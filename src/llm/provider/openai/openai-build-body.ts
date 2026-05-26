import { getConfig } from "../../../config/index.js";
import type { CompletionRequest } from "../completion-types.js";
import { filterCloudCompletionRequest } from "./sampling-filter.js";

export function buildOpenAiChatBody(
  request: CompletionRequest,
  defaultChatModel: string,
  stream: boolean,
): Record<string, unknown> {
  const filtered = filterCloudCompletionRequest(request);
  const body: Record<string, unknown> = {
    model: defaultChatModel,
    messages: [{ role: "user", content: filtered.prompt }],
    temperature: filtered.temperature ?? 0.2,
    max_tokens: filtered.maxTokens ?? getConfig().localModels.completionMaxTokens,
    stream,
  };
  if (filtered.stop) body.stop = filtered.stop;
  if (typeof filtered.seed === "number") body.seed = filtered.seed;
  if (filtered.tools && filtered.tools.length > 0) {
    body.tools = filtered.tools;
    body.parallel_tool_calls = filtered.parallelToolCalls ?? true;
    if (filtered.toolChoice !== undefined) {
      body.tool_choice = filtered.toolChoice;
    }
  }
  return body;
}
