import { describe, expect, it, vi } from "vitest";

import { LlamaServerError } from "../llama-server-client.js";
import {
  humanizeOpenAiHttpError,
  OpenAiHttpError,
} from "../provider/openai/openai-http.js";
import { OpenAiProvider } from "../provider/openai/openai-provider.js";
import { OpenAiSseError } from "../provider/openai/openai-stream-consumer.js";
import { parseProviderErrorBody } from "../provider/openai/parse-provider-error-body.js";
import { TransportError } from "./llm-failures.js";
import { classifyProviderWaitCause } from "./provider-wait-cause.js";

const URL = "https://api.fake.test/v1/chat/completions";

/** What the agent loop sees: the step executor's wrapper around the typed error. */
function asStepFailure(err: OpenAiHttpError): TransportError {
  return new TransportError(humanizeOpenAiHttpError(err), err.status, err.url, {
    cause: err,
  });
}

/** The HTTP error a stream-reported failure becomes (`httpErrorFromSse`). */
function fromStream(status: number | null, message: string): OpenAiHttpError {
  const sse = new OpenAiSseError(status, message, "gen-1");
  return new OpenAiHttpError(
    `openai provider ${status ?? "stream"}: ${message}`,
    status,
    URL,
    false,
    null,
    "fake",
    undefined,
    { cause: sse, streamError: message },
  );
}

function errno(code: string, message = "fetch failed"): Error {
  const inner = Object.assign(new Error(code), { code });
  return new Error(message, { cause: inner });
}

describe("classifyProviderWaitCause", () => {
  it("a reply the provider ended with an error finish is not an HTTP status", () => {
    // The stream consumer types this with a status so the loop parks on
    // it; the response itself was a 200 and was never retried.
    const err = asStepFailure(
      fromStream(502, "the provider ended the completion with an error (MALFORMED_FUNCTION_CALL)"),
    );
    expect(classifyProviderWaitCause(err)).toEqual({ kind: "error_finish" });
  });

  it("an error event inside the stream keeps the code the event carried", () => {
    expect(
      classifyProviderWaitCause(asStepFailure(fromStream(504, "Upstream idle timeout"))),
    ).toEqual({ kind: "stream_error", status: 504 });
    expect(
      classifyProviderWaitCause(asStepFailure(fromStream(null, "stream error"))),
    ).toEqual({ kind: "stream_error", status: null });
  });

  it("a provider that refused because the account cannot pay is billing, through the wrapper", () => {
    // Item 40: AI/ML API's 403 for an empty account, and OpenAI's 429
    // insufficient_quota. The TransportError carries the status alone.
    const aiml = '{"title":"Forbidden","status":403,"message":"You\'ve run out of funds. Please top up your balance"}';
    const out = new OpenAiHttpError(`openai provider 403: ${aiml}`, 403, URL, false, null, "aimlapi", undefined, {
      body: parseProviderErrorBody(aiml),
    });
    expect(classifyProviderWaitCause(asStepFailure(out))).toEqual({ kind: "billing", status: 403 });
    expect(classifyProviderWaitCause(out)).toEqual({ kind: "billing", status: 403 });
    const quota = '{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}';
    expect(
      classifyProviderWaitCause(
        asStepFailure(
          new OpenAiHttpError(`openai provider 429: ${quota}`, 429, URL, false, null, "openai", undefined, {
            body: parseProviderErrorBody(quota),
          }),
        ),
      ),
    ).toEqual({ kind: "billing", status: 429 });
    // A rate limit, and a 403 about the key, stay what they were.
    expect(
      classifyProviderWaitCause(asStepFailure(new OpenAiHttpError("openai provider 429: slow down", 429, URL))),
    ).toEqual({ kind: "http", status: 429 });
    expect(
      classifyProviderWaitCause(asStepFailure(new OpenAiHttpError("openai provider 403: Invalid API key", 403, URL))),
    ).toEqual({ kind: "http", status: 403 });
  });

  it("an HTTP status only when a response carried one", () => {
    const err = new OpenAiHttpError("openai provider 503: busy", 503, URL);
    expect(classifyProviderWaitCause(asStepFailure(err))).toEqual({
      kind: "http",
      status: 503,
    });
  });

  it("llama.cpp's 503 while the weights load is loading, not an error status", () => {
    const err = new LlamaServerError(
      "llama-server returned http 503: Loading model",
      503,
      "http://127.0.0.1:8080/completion",
    );
    const wrapped = new TransportError(err.message, 503, err.url, { cause: err });
    expect(classifyProviderWaitCause(wrapped)).toEqual({ kind: "loading" });
  });

  it("our own deadline and a provider timeout are timeouts", () => {
    const cloud = new OpenAiHttpError("timed out", null, URL, true);
    expect(classifyProviderWaitCause(asStepFailure(cloud))).toEqual({ kind: "timeout" });
    expect(classifyProviderWaitCause(errno("UND_ERR_HEADERS_TIMEOUT"))).toEqual({
      kind: "timeout",
    });
  });

  it("tells a refused, a dropped and an unreachable connection apart", () => {
    const refused = new LlamaServerError("fetch failed", null, "u", false, "ECONNREFUSED");
    expect(
      classifyProviderWaitCause(new TransportError("fetch failed", null, "u", { cause: refused })),
    ).toEqual({ kind: "refused" });
    expect(classifyProviderWaitCause(errno("ECONNRESET"))).toEqual({ kind: "dropped" });
    expect(classifyProviderWaitCause(new Error("terminated"))).toEqual({ kind: "dropped" });
    expect(classifyProviderWaitCause(errno("ENOTFOUND"))).toEqual({ kind: "unreachable" });
    expect(classifyProviderWaitCause(new Error("fetch failed"))).toEqual({
      kind: "unreachable",
    });
  });

  it("anything else is unknown rather than a guess", () => {
    expect(classifyProviderWaitCause(new Error("something odd"))).toEqual({ kind: "unknown" });
    expect(classifyProviderWaitCause("not an error")).toEqual({ kind: "unknown" });
  });

  it("the provider marks a failure reported inside a 200 stream as such", async () => {
    const frame = (obj: Record<string, unknown>) => `data: ${JSON.stringify(obj)}\n\n`;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          frame({ id: "gen-9", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }) +
            frame({ id: "gen-9", error: { code: 504, message: "Upstream idle timeout" } }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const provider = new OpenAiProvider({
      id: "fake",
      baseUrl: "https://api.fake.test",
      apiKey: "",
      defaultChatModel: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const stream = provider.completeStream({ prompt: "hi" });
    const err = await (async () => {
      for (;;) {
        const next = await stream.next();
        if (next.done) return null;
      }
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).streamError).toBe("Upstream idle timeout");
    const text = humanizeOpenAiHttpError(err as OpenAiHttpError);
    expect(text).toContain("error in the middle of its reply (504)");
    expect(text).not.toContain("Tried");
  });
});
