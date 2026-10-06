import { describe, expect, it } from "vitest";

import { attachFailedAttempts } from "../llm/fallback/failed-attempts.js";
import {
  humanizeOpenAiHttpError,
  OpenAiHttpError,
} from "../llm/provider/openai/openai-http.js";
import { parseProviderErrorBody } from "../llm/provider/openai/parse-provider-error-body.js";
import { classifyFailure } from "../llm/reliability/index.js";
import { TransportError } from "../llm/reliability/llm-failures.js";
import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * Which failure an HTTP host is told about.
 *
 * `runWithFallback` throws the LAST link's error untouched — it decides
 * classification and the outage wait — and records the links that failed
 * before it beside it. On the common chain [cloud provider, auto-appended
 * llama-server] the last link is a daemon that never ran, so a host that
 * shows one sentence per failed turn (the desktop app) must be given the
 * provider the operator picked: its refusal, in its own words, and its own
 * category — not the tail's `fetch failed`, which the desktop renders as
 * "<provider> is not answering" for a provider that answered.
 */
describe("loop_failed over SSE", () => {
  const makeSse = () => {
    const written: Array<{ name: string | null; payload: unknown }> = [];
    return {
      written,
      writer: {
        closed: false,
        writeEvent(name: string | null, payload: unknown) {
          written.push({ name, payload });
        },
      },
    };
  };
  const env = (extensionsEnabled: boolean) =>
    ({
      completionId: "cmpl-1",
      created: 0,
      session: { id: "sess-1" },
      request: { model: "atomic-agent", extensionsEnabled },
    }) as never;

  const refusal = () =>
    Object.assign(
      new Error(
        "openrouter rejected the request (402): This request requires more credits, or fewer max_tokens.",
      ),
      { status: 402 },
    );

  it("names the provider the operator picked when the chain fell over before failing", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));
    const primary = refusal();
    const tail = new TypeError("fetch failed");
    attachFailedAttempts(tail, [{ providerId: "openrouter", error: primary }]);

    hook({ type: "loop_failed", error: tail, category: classifyFailure(tail) } as never);

    expect(sse.written).toHaveLength(1);
    const frame = sse.written[0]!;
    expect(frame.name).toBe("error");
    const payload = frame.payload as { error: string; category?: string; fallback_failures?: unknown };
    expect(payload.error).toBe(primary.message);
    expect(payload.category).toBe(classifyFailure(primary));
    expect(payload.category).not.toBe("transport");
    expect(payload.fallback_failures).toEqual([
      { providerId: "openrouter", reason: primary.message },
    ]);
  });

  it("reports a single-link failure exactly as before", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));
    const only = new TypeError("fetch failed");

    hook({ type: "loop_failed", error: only, category: classifyFailure(only) } as never);

    expect(sse.written).toEqual([
      { name: "error", payload: { error: "fetch failed", category: "transport" } },
    ]);
  });

  it("gives an OpenAI-compatible client the primary's message in the standard envelope", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(false));
    const primary = refusal();
    const tail = new TypeError("fetch failed");
    attachFailedAttempts(tail, [{ providerId: "openrouter", error: primary }]);

    hook({ type: "loop_failed", error: tail, category: classifyFailure(tail) } as never);

    expect(sse.written).toHaveLength(1);
    const frame = sse.written[0]!;
    expect(frame.name).toBeNull();
    expect(JSON.stringify(frame.payload)).toContain("requires more credits");
    expect(JSON.stringify(frame.payload)).not.toContain("fallback_failures");
  });
});

/**
 * Item 40: a provider that refused because the account cannot pay. The
 * frame says so as data (`cause: {kind: "billing", status}`) beside the
 * agent's sentence, so a host shows that sentence as the failure instead
 * of "<provider> is not answering". The desktop holds the FIRST error
 * frame of a turn, which is the failed step's, so that one says it too,
 * with the links that failed before it.
 */
describe("a billing refusal over SSE", () => {
  const makeSse = () => {
    const written: Array<{ name: string | null; payload: unknown }> = [];
    return {
      written,
      writer: {
        closed: false,
        writeEvent(name: string | null, payload: unknown) {
          written.push({ name, payload });
        },
      },
    };
  };
  const env = {
    completionId: "cmpl-1",
    created: 0,
    session: { id: "sess-1" },
    request: { model: "atomic-agent", extensionsEnabled: true },
  } as never;

  const outOfFunds = (): OpenAiHttpError => {
    const body =
      '{"title":"Forbidden","status":403,"message":"You\'ve run out of funds. Please top up your balance"}';
    return new OpenAiHttpError(
      `openai provider 403: ${body}`,
      403,
      "https://api.aimlapi.com/v1/chat/completions",
      false,
      null,
      "aimlapi",
      undefined,
      { body: parseProviderErrorBody(body) },
    );
  };
  /** What the step executor hands the loop: the sentence, the provider's error as the cause. */
  const stepFailure = (http: OpenAiHttpError) =>
    new TransportError(humanizeOpenAiHttpError(http), http.status, http.url, { cause: http });

  it("marks the turn's failure as billing, with the agent's sentence", () => {
    const sse = makeSse();
    const failure = stepFailure(outOfFunds());
    buildStreamEventHook(sse.writer as never, env)({
      type: "loop_failed",
      error: failure,
      category: "transport",
    } as never);
    expect(sse.written).toEqual([
      {
        name: "error",
        payload: {
          error: failure.message,
          category: "transport",
          cause: { kind: "billing", status: 403 },
        },
      },
    ]);
    expect(failure.message).toMatch(/^AI\/ML API refused the request: you've run out of funds\./);
  });

  it("marks the failed step's frame the same way", () => {
    const sse = makeSse();
    const failure = stepFailure(outOfFunds());
    buildStreamEventHook(sse.writer as never, env)({
      type: "llm_event",
      event: { type: "step_error", error: failure, category: "transport" },
    } as never);
    expect(sse.written[0]).toEqual({
      name: "error",
      payload: {
        error: failure.message,
        category: "transport",
        cause: { kind: "billing", status: 403 },
      },
    });
  });

  it("lists the picked provider's billing refusal on the failed step of a later link", () => {
    const sse = makeSse();
    const tail = new TypeError("fetch failed");
    attachFailedAttempts(tail, [{ providerId: "aimlapi", error: outOfFunds() }]);
    const failure = new TransportError("fetch failed", null, "", { cause: tail });
    buildStreamEventHook(sse.writer as never, env)({
      type: "llm_event",
      event: { type: "step_error", error: failure, category: "transport" },
    } as never);
    const payload = sse.written[0]!.payload as Record<string, unknown>;
    expect(payload.error).toBe("fetch failed");
    expect(payload).not.toHaveProperty("cause");
    expect(payload.fallback_failures).toEqual([
      {
        providerId: "aimlapi",
        reason: expect.stringContaining("run out of funds"),
        cause: { kind: "billing", status: 403 },
      },
    ]);
  });

  it("tells the turn's failure as the fallback's billing refusal that ended it, the links before it beside it", () => {
    // runWithFallback's route refusal: the fallback the turn was running on
    // said the account is empty, after the primary (down) was probed.
    const sse = makeSse();
    const fallback = outOfFunds();
    attachFailedAttempts(fallback, [
      {
        providerId: "primary",
        error: new OpenAiHttpError("openai provider 503: upstream down", 503, "https://primary.example/v1/chat/completions"),
      },
    ]);
    const failure = stepFailure(fallback);
    buildStreamEventHook(sse.writer as never, env)({
      type: "loop_failed",
      error: failure,
      category: "transport",
    } as never);
    expect(sse.written).toEqual([
      {
        name: "error",
        payload: {
          error: failure.message,
          category: "transport",
          cause: { kind: "billing", status: 403 },
          fallback_failures: [
            {
              providerId: "primary",
              reason: "openai provider 503: upstream down",
              cause: { kind: "http", status: 503 },
            },
          ],
        },
      },
    ]);
  });

  it("leaves a failed step with nothing before it and no billing exactly as before", () => {
    const sse = makeSse();
    const only = new TypeError("fetch failed");
    buildStreamEventHook(sse.writer as never, env)({
      type: "llm_event",
      event: { type: "step_error", error: only, category: "transport" },
    } as never);
    expect(sse.written).toEqual([
      { name: "error", payload: { error: "fetch failed", category: "transport" } },
    ]);
  });
});
