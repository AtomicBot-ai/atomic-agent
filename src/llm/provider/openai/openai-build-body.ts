import type { CompletionRequest } from "../completion-types.js";
import { filterCloudCompletionRequest } from "./sampling-filter.js";

/**
 * Fields the caller owns unconditionally. `extraBody` is merged *under*
 * these, so a vendor passthrough can add `chat_template_kwargs` or
 * `enable_thinking` but can never detach the request from the resolved
 * model, rewrite the prompt, flip streaming, or drop the tool contract.
 */
const RESERVED_BODY_KEYS = ["model", "messages", "stream", "tools"] as const;

export function buildOpenAiChatBody(
  request: CompletionRequest,
  defaultChatModel: string,
  stream: boolean,
  extraBody?: Record<string, unknown>,
  maxOutputTokens?: number,
): Record<string, unknown> {
  const filtered = filterCloudCompletionRequest(request);
  const body: Record<string, unknown> = {
    model: defaultChatModel,
    messages: [{ role: "user", content: filtered.prompt }],
    temperature: filtered.temperature ?? 0.2,
    stream,
  };
  // `max_tokens` only when somebody actually asked for a bound.
  //
  // It used to default to `localModels.completionMaxTokens` — the
  // llama-server `n_predict` knob, 8192 — which is the wrong number for
  // a cloud model twice over: it is sized for a local runner's decode
  // budget, and it silently capped every cloud completion at a fraction
  // of what the model can emit. A turn that legitimately writes a long
  // file (a whole page, a large refactor) hit that wall mid-JSON, the
  // provider reported `finish_reason: "length"`, and the turn died with
  // "model response truncated at 8192 tokens" — a limit nobody chose and
  // nothing in the UI named.
  //
  // Omitted, the server applies the model's own default, which is what
  // an operator picking a cloud model expects. A provider that requires
  // the field, or a deployment that wants a hard ceiling, sets it
  // through the entry's `extraBody` — `max_tokens` is deliberately not
  // in `RESERVED_BODY_KEYS`, so that passthrough wins.
  // Order: what this call asked for, else the provider's configured
  // ceiling, else nothing at all.
  const cap = filtered.maxTokens ?? maxOutputTokens;
  if (typeof cap === "number") body.max_tokens = cap;
  if (stream) {
    // Ask for the usage block on the stream's last chunk. Without it
    // most servers send none — OpenAI, llama.cpp and everything built on
    // it — and a reply cut off by `finish_reason: "length"` then arrives
    // with no token counts, which is exactly what tells a spent reply
    // cap apart from a full context window (`classifyTruncation`).
    // Providers that never needed the flag ignore it (OpenRouter,
    // Anthropic's compatibility layer); Gemini honours it from 2.5. A
    // vendor that rejects it can drop it through `extraBody`.
    body.stream_options = { include_usage: true };
  }
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
  if (!extraBody) return body;
  // Vendor passthrough. Merged last so it can reach fields this builder
  // does not model, then reserved keys are restored on top.
  const merged: Record<string, unknown> = { ...body, ...extraBody };
  for (const key of RESERVED_BODY_KEYS) {
    if (key in body) merged[key] = body[key];
    else delete merged[key];
  }
  return merged;
}
