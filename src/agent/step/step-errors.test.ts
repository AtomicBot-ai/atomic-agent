import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_CLI_TOOL_TAG, toLlmFailure } from "./step-errors.js";
import type { StepContext } from "./step-contract.js";
import { LlamaServerError, readLlamaErrorBody } from "../../llm/llama-server-client.js";
import { GrammarError, ToolExecutionError, TransportError } from "../../llm/reliability/llm-failures.js";
import { SubscriptionCliInvocationError } from "../../llm/provider/subscription-cli/subscription-cli-errors.js";
import { extractSafeTool } from "../../error-reporting/error-scrubber.js";
import { RequestTooLargeError } from "../../llm/reliability/request-too-large.js";
import { classifyFailure } from "../../llm/reliability/classify-failure.js";
import { shouldAdvance } from "../../llm/fallback/should-advance.js";
import { contextCompactionRejection } from "../turn/compaction-recovery.js";
import { OpenAiHttpError } from "../../llm/provider/openai/openai-http.js";
import { parseProviderErrorBody } from "../../llm/provider/openai/parse-provider-error-body.js";

const URL = "http://127.0.0.1:9931/completion";
const ctx = { signal: new AbortController().signal } as unknown as StepContext;

function llamaHttp(status: number, rawBody: string): LlamaServerError {
  const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
  const detail = parsed.error?.message ?? "";
  const body = readLlamaErrorBody(rawBody);
  return new LlamaServerError(
    `llama-server returned http ${status}${detail ? `: ${detail}` : ""}`,
    status, URL, false, undefined, body !== undefined ? { body } : undefined,
  );
}

const overflowBody = (message: string): string => JSON.stringify({
  error: { code: 400, message, type: "exceed_context_size_error", n_prompt_tokens: 5369, n_ctx: 4096 },
});

describe("toLlmFailure: llama-server size refusals (ATO-422)", () => {
  it("files an exceed_context_size_error 400 as RequestTooLargeError, not GrammarError", () => {
    const raw = llamaHttp(400, overflowBody("the request exceeds the available context size, try increasing it"));
    const failure = toLlmFailure(raw, ctx);
    expect(failure).toBeInstanceOf(RequestTooLargeError);
    expect(failure).not.toBeInstanceOf(GrammarError);
    expect(failure.name).toBe("RequestTooLargeError");
    expect(failure.message).toMatch(/^The request does not fit the model's context window/);
    expect(failure.message).toContain("try increasing it");
    expect(failure.cause).toBe(raw);
  });

  it("names the window when the server's sentence carries it", () => {
    const raw = llamaHttp(400, overflowBody(
      "request (5369 tokens) exceeds the available context size (4096 tokens), try increasing it",
    ));
    const failure = toLlmFailure(raw, ctx) as RequestTooLargeError;
    expect(failure).toBeInstanceOf(RequestTooLargeError);
    expect(failure.contextWindow).toBe(4096);
    expect(failure.message).toContain("context window (4096 tokens)");
  });

  it("keeps the routing of the old wrapper: no fallover, still found by the overflow compaction", () => {
    const raw = llamaHttp(400, overflowBody("the request exceeds the available context size, try increasing it"));
    const failure = toLlmFailure(raw, ctx);
    expect(failure.category).toBe("grammar");
    expect(classifyFailure(failure)).toBe("grammar");
    expect(shouldAdvance(failure).advance).toBe(false);
    expect(contextCompactionRejection(failure)).toBe(raw);
  });

  it("files a 413 as RequestTooLargeError", () => {
    const raw = new LlamaServerError("llama-server returned http 413", 413, URL);
    const failure = toLlmFailure(raw, ctx);
    expect(failure).toBeInstanceOf(RequestTooLargeError);
    expect(failure.message).toBe(
      "The model server refused the request as too large. llama-server returned http 413",
    );
    expect(shouldAdvance(failure).advance).toBe(false);
  });

  it("recognises the older untyped wording", () => {
    const raw = new LlamaServerError(
      "llama-server returned http 400: input is too large to process. increase the physical batch size",
      400, URL,
    );
    expect(toLlmFailure(raw, ctx)).toBeInstanceOf(RequestTooLargeError);
  });

  it("keeps a grammar parse 400 a GrammarError", () => {
    const raw = llamaHttp(400, JSON.stringify({
      error: { code: 400, message: "Failed to parse grammar", type: "invalid_request_error" },
    }));
    const failure = toLlmFailure(raw, ctx);
    expect(failure).toBeInstanceOf(GrammarError);
    expect(failure.message).toBe("llama-server returned http 400: Failed to parse grammar");
  });

  it("leaves any other 400 and 422 as they were", () => {
    for (const raw of [
      new LlamaServerError("llama-server returned http 400: invalid 'n_probs'", 400, URL),
      new LlamaServerError("llama-server returned http 422", 422, URL),
    ]) {
      const failure = toLlmFailure(raw, ctx);
      expect(failure).toBeInstanceOf(GrammarError);
      expect(failure.message).toBe(raw.message);
    }
  });

  it("leaves endpoint statuses on transport", () => {
    const raw = new LlamaServerError("llama-server returned http 404", 404, URL);
    expect(toLlmFailure(raw, ctx)).toBeInstanceOf(TransportError);
  });
});

describe("toLlmFailure: the tool a catch-all failure names (ATO-710)", () => {
  it("names a failed subscription CLI run, not an unknown tool", () => {
    const raw = new SubscriptionCliInvocationError('"cli" exited with code 1: no output', 1);
    const failure = toLlmFailure(raw, ctx);
    expect(failure).toBeInstanceOf(ToolExecutionError);
    expect((failure as ToolExecutionError).tool).toBe(SUBSCRIPTION_CLI_TOOL_TAG);
    // The category is unchanged: a CLI that ran does not advance the chain.
    expect(failure.category).toBe("tool");
    expect(failure.cause).toBe(raw);
    // The word passes the scrubber's identifier allowlist, so it reaches the report.
    expect(extractSafeTool(failure)).toBe("subscription_cli");
  });

  it("keeps \"unknown\" for a plain error nothing attributes", () => {
    const failure = toLlmFailure(new SyntaxError("Unexpected token"), ctx);
    expect(failure).toBeInstanceOf(ToolExecutionError);
    expect((failure as ToolExecutionError).tool).toBe("unknown");
  });
});

describe("toLlmFailure: Groq's 413 over the plan limit (ATO-1283)", () => {
  it("reads the plan-limit sentence alone, without Groq's raw body after it", () => {
    const text = JSON.stringify({ error: {
      message: "Request too large for model `llama-3.3-70b-versatile` in organization `org_01abc` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Requested 9531, please reduce your message size and try again.",
      type: "tokens", code: "rate_limit_exceeded",
    } });
    const raw = new OpenAiHttpError(
      `openai provider 413: ${text.slice(0, 300)}`, 413,
      "https://api.groq.com/openai/v1/chat/completions", false, null, "groq", undefined,
      { body: parseProviderErrorBody(text) },
    );
    const failure = toLlmFailure(raw, ctx);
    expect(failure).toBeInstanceOf(TransportError);
    expect(failure.message).toBe(
      "Groq refused the request (413): it is larger than your Groq plan's limit (limit 6000 tokens per minute, this request 9531). " +
      "Pick a model with a higher limit or a larger Groq plan.",
    );
    expect(failure.cause).toBe(raw);
  });
});
