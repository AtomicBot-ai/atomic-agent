import { describe, expect, it } from "vitest";

import {
  WebSearchBlockedError,
  WebSearchUnavailableError,
} from "../../tools/os/web-search/web-search-errors.js";
import { ToolCallParseError } from "../grammar/tool-call-grammar.js";
import { LlamaServerError } from "../llama-server-client.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { parseProviderErrorBody } from "../provider/openai/parse-provider-error-body.js";
import { SubscriptionCliNotInstalledError } from "../provider/subscription-cli/subscription-cli-errors.js";
import { classifyFailureCause } from "./classify-failure-cause.js";
import type { FailureAction, FailureCauseId } from "./failure-catalog.js";
import {
  CancelledError,
  GrammarError,
  ModelError,
  ToolExecutionError,
  TransportError,
} from "./llm-failures.js";
import { LocalEngineDownError } from "./local-engine-down.js";

const URL = "https://api.fake.test/v1/chat/completions";
const LLAMA = "http://127.0.0.1:8080/completion";

/** What the agent loop sees: the step executor's wrapper around a typed error. */
function stepFailure(err: OpenAiHttpError | LlamaServerError): TransportError {
  return new TransportError(err.message, err.status, err.url, { cause: err });
}

function http(status: number, message: string, body?: string): OpenAiHttpError {
  return new OpenAiHttpError(
    `openai provider ${status}: ${message}`,
    status,
    URL,
    false,
    null,
    "fake",
    undefined,
    body === undefined ? undefined : { body: parseProviderErrorBody(body) },
  );
}

function errno(code: string): Error {
  return new Error("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

const truncated = (cause: "context_window" | "reply_cap", repetitive?: true) =>
  new ModelError("truncated", "the reply was cut off", {
    truncation: {
      cause,
      completionTokens: 512,
      promptTokens: 30_000,
      ...(repetitive ? { repetitive } : {}),
    },
  });

/** One sample raw error per cause, as the loop would hand it over. */
const SAMPLES: ReadonlyArray<
  readonly [string, unknown, FailureCauseId, FailureAction]
> = [
  [
    "a Metal out-of-memory from llama-server",
    stepFailure(
      new LlamaServerError(
        "llama-server returned http 500: kIOGPUCommandBufferCallbackErrorOutOfMemory",
        500,
        LLAMA,
      ),
    ),
    "out_of_memory",
    "reduce-load",
  ],
  [
    "a CUDA buffer that could not be allocated",
    stepFailure(
      new LlamaServerError("llama-server returned http 500: failed to allocate buffer", 500, LLAMA),
    ),
    "out_of_memory",
    "reduce-load",
  ],
  [
    "our own first-token deadline on the local server",
    stepFailure(new LlamaServerError("first token did not arrive within 1800s", null, LLAMA, true)),
    "slow_local_model",
    "switch-model",
  ],
  ["a local model that is not running", new LocalEngineDownError("local-llama"), "local_engine_down", "none"],
  [
    "llama.cpp still reading the weights",
    stepFailure(new LlamaServerError("llama-server returned http 503: Loading model", 503, LLAMA)),
    "model_loading",
    "retry",
  ],
  ["a reply that ran into the context window", truncated("context_window"), "context_too_long", "new-chat-summary"],
  [
    "a cloud 400 naming the maximum context length",
    stepFailure(
      http(400, "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens."),
    ),
    "context_too_long",
    "new-chat-summary",
  ],
  [
    "llama.cpp refusing a prompt bigger than its window",
    new LlamaServerError(
      "llama-server returned http 400: the request exceeds the available context size, try increasing it",
      400,
      LLAMA,
    ),
    "context_too_long",
    "new-chat-summary",
  ],
  ["a 429 rate limit", stepFailure(http(429, "slow down")), "rate_limited", "retry"],
  ["an empty completion", new ModelError("empty", "model returned empty content"), "empty_response", "retry"],
  [
    "a 402 for an empty balance",
    new TransportError("openrouter rejected the request (402)", 402, URL),
    "out_of_credit",
    "switch-model",
  ],
  [
    "AI/ML API's 403 'run out of funds'",
    stepFailure(
      http(
        403,
        "out of funds",
        '{"title":"Forbidden","status":403,"message":"You\'ve run out of funds. Please top up your balance"}',
      ),
    ),
    "out_of_credit",
    "switch-model",
  ],
  ["a 401 for a bad key", stepFailure(http(401, "Invalid API key")), "auth_rejected", "switch-model"],
  ["a 404 for a model the provider lacks", stepFailure(http(404, "no such model")), "model_not_found", "switch-model"],
  ["a 422 the provider refused", stepFailure(http(422, "bad tool schema")), "request_rejected", "switch-model"],
  ["a 503 from the provider", stepFailure(http(503, "busy")), "provider_trouble", "retry"],
  [
    "an error event inside an open stream",
    stepFailure(
      new OpenAiHttpError("openai provider 504: Upstream idle timeout", 504, URL, false, null, "fake", undefined, {
        streamError: "Upstream idle timeout",
      }),
    ),
    "provider_error_mid_reply",
    "retry",
  ],
  [
    "a subscription CLI that is not installed",
    new TransportError("not installed", null, "", { cause: new SubscriptionCliNotInstalledError("claude") }),
    "provider_setup",
    "none",
  ],
  [
    "a refused connection",
    new TransportError("fetch failed", null, LLAMA, {
      cause: new LlamaServerError("fetch failed", null, LLAMA, false, "ECONNREFUSED"),
    }),
    "connection_refused",
    "retry",
  ],
  ["a reset socket", errno("ECONNRESET"), "connection_dropped", "retry"],
  ["DNS that does not resolve", errno("ENOTFOUND"), "offline", "retry"],
  [
    "a cloud request that timed out",
    stepFailure(new OpenAiHttpError("timed out", null, URL, true)),
    "provider_timeout",
    "retry",
  ],
  ["a cut-off reply", truncated("reply_cap"), "reply_cut_off", "retry"],
  ["a reply with no stop token", new ModelError("no_stop", "no stop token"), "unfinished_reply", "retry"],
  [
    "a reply that looped on one block of text",
    truncated("reply_cap", true),
    "repeating_output",
    "switch-model",
  ],
  ["a completion that did not parse", new GrammarError("bad json", "{"), "unreadable_reply", "switch-model"],
  ["a raw tool-call parse error", new ToolCallParseError("unexpected token"), "unreadable_reply", "switch-model"],
  [
    "web search out of keyless quota",
    new WebSearchUnavailableError("exa", "every search provider failed", ["exa: 429"], {
      provider: "exa",
      reason: "rate_limited",
      getKeyUrl: "https://dashboard.exa.ai/api-keys",
      envVar: "EXA_API_KEY",
    }),
    "web_search_needs_key",
    "add-search-key",
  ],
  [
    "web search failing with a key set",
    new WebSearchUnavailableError("exa", "every search provider failed", ["exa: 500"]),
    "web_search_unavailable",
    "retry",
  ],
  ["a blocked search provider", new WebSearchBlockedError("duckduckgo"), "web_search_unavailable", "retry"],
  [
    "a tool that threw",
    new ToolExecutionError("os.fs.read", "EACCES"),
    "tool_crashed",
    "retry",
  ],
  ["a user abort", new CancelledError(), "cancelled", "none"],
  ["something that is not even an Error", "not even an error", "tool_crashed", "retry"],
];

describe("classifyFailureCause", () => {
  it.each(SAMPLES)("%s → %s", (_label, err, cause, action) => {
    const verdict = classifyFailureCause(err);
    expect(verdict.cause).toBe(cause);
    expect(verdict.action).toBe(action);
    expect(verdict.phrase.length).toBeGreaterThan(0);
  });

  it("the category the loop decided wins for a cancelled turn", () => {
    // An abort can surface as a transport error before the AbortError does.
    const verdict = classifyFailureCause(new TransportError("terminated", null, LLAMA), "cancelled");
    expect(verdict).toEqual({ cause: "cancelled", phrase: "You stopped this turn.", action: "none" });
  });

  it("a status-less transport failure with nothing to read is the provider not replying", () => {
    expect(classifyFailureCause(new TransportError("odd", null, URL)).cause).toBe("provider_unreachable");
  });

  it("the bare category decides when nothing more specific is known", () => {
    expect(classifyFailureCause(new Error("x"), "model").cause).toBe("unfinished_reply");
    expect(classifyFailureCause(new Error("x"), "grammar").cause).toBe("unreadable_reply");
  });

  it("names memory before the timeout it shows up as", () => {
    const err = new TransportError("timed out", null, LLAMA, {
      cause: new LlamaServerError("ggml: out of memory while decoding", null, LLAMA, true),
    });
    expect(classifyFailureCause(err).cause).toBe("out_of_memory");
  });

  it("a max_tokens refusal that does not name the context is not 'chat too long'", () => {
    const err = stepFailure(http(400, "max_tokens is too large: 100000. This model supports at most 32768 completion tokens"));
    expect(classifyFailureCause(err).cause).toBe("request_rejected");
  });
});
