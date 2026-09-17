import type { CompletionRequest } from "../completion-types.js";
import { hasStrictFunctionTools } from "../adapters/tool-call-adapter.js";
import { ensureJsonMention } from "./ensure-json-mention.js";
import { filterCloudCompletionRequest } from "./sampling-filter.js";
import { modelParamProfile, reasoningEffortField } from "./model-params.js";
import { buildNativeMessages } from "./openai-native-messages.js";
import { toStrictOpenAiTools } from "./openai-strict-tools.js";
import { nameEscape } from "./openai-tool-call-adapter.js";
import { applyAnthropicCacheControl } from "./prompt-cache-control.js";

/**
 * Fields the caller owns unconditionally. `extraBody` is merged *under*
 * these, so a vendor passthrough can add `chat_template_kwargs` or
 * `enable_thinking` but can never detach the request from the resolved
 * model, rewrite the prompt, flip streaming, or drop the tool contract.
 */
const RESERVED_BODY_KEYS = ["model", "messages", "stream", "tools"] as const;

/**
 * What the builder knows about the provider and model beyond the request
 * itself. Every field is optional and absent leaves the body exactly as
 * it was before the field existed.
 */
export interface OpenAiBodyOptions {
  /**
   * Per-model wire parameters from `userModels[].params`, merged over the
   * body *and* over `extraBody` — a model-level setting is more specific
   * than a provider-level one. Reserved keys still win.
   */
  modelParams?: Record<string, unknown>;
  /**
   * The registered kind sending this body, for fields whose spelling is
   * the vendor's (`reasoningEffort`). Absent, those fields are omitted.
   */
  providerKind?: string;
  /**
   * Place Anthropic prompt-cache breakpoints on the messages (see
   * `prompt-cache-control.ts`). Decided by the provider from the model
   * id, the host and the entry's `promptCache` policy.
   */
  anthropicCacheControl?: boolean;
  /**
   * How a request that carries `messages` (the structured prompt) is
   * laid out: `native` as `system` + history + final `user`
   * (`openai-native-messages.ts`), `flat` as the one `user` message of
   * text every request used to be. A request without `messages` is
   * always flat. Default `native`.
   */
  messageShape?: "native" | "flat";
  /** The adapter's tool-name escape, for the history's `tool_calls`. */
  nameEscape?: (qualifiedName: string) => string;
}

/** The wire layout `buildOpenAiChatBody` chose for a request. */
export function resolveMessageShape(
  request: Pick<CompletionRequest, "messages" | "tools">,
  options: Pick<OpenAiBodyOptions, "messageShape">,
): "native" | "flat" {
  if (!request.messages) return "flat";
  if (!request.tools || request.tools.length === 0) return "flat";
  return options.messageShape ?? "native";
}

export function buildOpenAiChatBody(
  request: CompletionRequest,
  defaultChatModel: string,
  stream: boolean,
  extraBody?: Record<string, unknown>,
  maxOutputTokens?: number,
  strictTools?: boolean,
  providerPreferences?: Record<string, unknown>,
  options: OpenAiBodyOptions = {},
): Record<string, unknown> {
  const filtered = filterCloudCompletionRequest(request);
  const profile = modelParamProfile(defaultChatModel);
  // Settled before the body exists because it also decides the prompt:
  // a request that sends `response_format` must mention JSON (see
  // `ensureJsonMention`). The tools guard is explained where
  // `response_format` is attached below.
  const responseFormat =
    filtered.tools && filtered.tools.length > 0
      ? undefined
      : filtered.responseFormat;
  // The structured prompt rides only on a main turn (it needs `tools`
  // to answer with), and only when the provider takes the native
  // layout; a sub-call, or a service that refused the layout, sends the
  // flat text — which `messages` was built beside, from the same packed
  // conversation, so both say the same thing.
  const messages =
    resolveMessageShape(filtered, options) === "native" && filtered.messages
      ? buildNativeMessages(filtered.messages, {
          nameEscape: options.nameEscape ?? nameEscape,
        })
      : [
          {
            role: "user",
            content: responseFormat
              ? ensureJsonMention(filtered.prompt)
              : filtered.prompt,
          },
        ];
  const body: Record<string, unknown> = {
    model: defaultChatModel,
    messages,
    // OpenAI's reasoning models reject the field outright (`Unsupported
    // parameter: 'temperature'`), so for them it is not sent at all —
    // not even a caller's own value. See `model-params.ts`.
    ...(profile.temperature
      ? { temperature: filtered.temperature ?? 0.2 }
      : {}),
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
  // Order: what this call asked for, else the turn's own ceiling (a
  // fusion worker's `workerMaxOutputTokens`), else the provider's
  // configured ceiling, else nothing at all. The field is the model
  // family's own: OpenAI's reasoning models answer `max_tokens` with
  // "'max_tokens' is not supported with this model. Use
  // 'max_completion_tokens' instead."
  const cap =
    filtered.maxTokens ?? filtered.maxOutputTokens ?? maxOutputTokens;
  if (typeof cap === "number") body[profile.capField] = cap;
  // Reasoning effort, in the field this kind reads (`model-params.ts`);
  // omitted for a kind without a known one rather than guessed.
  if (filtered.reasoningEffort !== undefined) {
    Object.assign(
      body,
      reasoningEffortField(options.providerKind, filtered.reasoningEffort),
    );
  }
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
    // Strict function tools, when the provider entry opted in. Done
    // here — before the `extraBody` merge — precisely because `tools`
    // is a reserved key: the loop below restores `body.tools` over the
    // merge, so the transformed array is what survives. Off by default,
    // and off it must leave this line byte-identical to what it was.
    const emittedTools = strictTools
      ? toStrictOpenAiTools(filtered.tools)
      : filtered.tools;
    body.tools = emittedTools;
    // Structured Outputs and parallel function calls do not compose:
    // OpenAI documents that a parallel call generated under strict mode
    // "may not match supplied schemas" and says to send
    // `parallel_tool_calls: false`.
    //
    // Keyed to the array that actually goes on the wire, which covers
    // both ways a request can end up carrying strict functions: the
    // provider flag above, which marks every tool, and a caller that
    // marked some itself (`buildLlmStreamParams`). Whoever builds the
    // request, it cannot leave here asking for parallel calls with a
    // `strict: true` function in the payload. The executor's own
    // `maxParallelToolCalls` batching is untouched, and a provider
    // without either keeps today's value verbatim.
    body.parallel_tool_calls =
      !hasStrictFunctionTools(emittedTools) &&
      (filtered.parallelToolCalls ?? true);
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
  if (responseFormat) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: responseFormat.name,
        ...(responseFormat.description
          ? { description: responseFormat.description }
          : {}),
        schema: responseFormat.schema,
        strict: responseFormat.strict ?? true,
      },
    };
  }
  // OpenRouter provider routing (`order`, `only`, `allow_fallbacks`, …).
  // Set before the passthrough on purpose: an explicit
  // `extraBody.provider` is the older way to say the same thing, and it
  // keeps winning. Absent, the body is byte-identical to what it was.
  if (providerPreferences) body.provider = providerPreferences;
  if (options.anthropicCacheControl) {
    body.messages = applyAnthropicCacheControl(
      body.messages as ReadonlyArray<Record<string, unknown>>,
    );
  }
  const modelParams = options.modelParams;
  if (!extraBody && !modelParams) return body;
  // Vendor passthrough, then the model's own parameters. Merged last so
  // they can reach fields this builder does not model, then reserved
  // keys are restored on top.
  const merged: Record<string, unknown> = {
    ...body,
    ...extraBody,
    ...modelParams,
  };
  for (const key of RESERVED_BODY_KEYS) {
    if (key in body) merged[key] = body[key];
    else delete merged[key];
  }
  return merged;
}
