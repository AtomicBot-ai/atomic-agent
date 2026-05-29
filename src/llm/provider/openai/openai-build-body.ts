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
  // OpenAI Structured Outputs. Used by reflection/link-gen/vote/
  // rewriter/distill sub-runners — GBNF cannot be enforced over
  // OpenAI-compatible APIs, so this is the cross-vendor equivalent.
  // We do NOT set `response_format` together with `tools`: when the
  // model is calling a tool, the function's `parameters` schema is
  // already the JSON contract. Combining the two confuses some
  // providers (Azure rejects, OpenRouter degrades silently).
  if (
    filtered.responseFormat &&
    !(filtered.tools && filtered.tools.length > 0)
  ) {
    const schemaName = filtered.responseFormat.name;
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        ...(filtered.responseFormat.description
          ? { description: filtered.responseFormat.description }
          : {}),
        schema: filtered.responseFormat.schema,
        strict: filtered.responseFormat.strict ?? true,
      },
    };
  }
  return body;
}
