import { describe, expect, it, vi } from "vitest";

import {
  CONTRACT_PROBE_TOOL_NAME,
  type ProviderContractProbeTarget,
} from "./contract-probe-types.js";
import { runProviderContractProbe } from "./run-contract-probe.js";

const TARGET: ProviderContractProbeTarget = {
  label: "OmniRoute",
  baseUrl: "https://route.example",
  apiPathPrefix: "/v1",
  apiKey: "sk-secret-probe-key",
  model: "vendor/some-model",
};

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const TOOL_CALL_STREAM =
  sseEvent({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: CONTRACT_PROBE_TOOL_NAME, arguments: '{"ok"' },
            },
          ],
        },
      },
    ],
  }) +
  sseEvent({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: ":true}" } }],
        },
      },
    ],
  }) +
  sseEvent({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
  "data: [DONE]\n\n";

const TEXT_STREAM =
  sseEvent({ choices: [{ delta: { content: "Happy to help." } }] }) +
  sseEvent({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
  "data: [DONE]\n\n";

/** Truncated: the arguments never close and nothing announces the end. */
const EARLY_EOF_STREAM = sseEvent({
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            type: "function",
            function: { name: CONTRACT_PROBE_TOOL_NAME, arguments: '{"ok"' },
          },
        ],
      },
    },
  ],
});

const MALFORMED_STREAM =
  sseEvent({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              type: "function",
              function: { name: CONTRACT_PROBE_TOOL_NAME, arguments: '{"ok":' },
            },
          ],
        },
      },
    ],
  }) + sseEvent({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });

/**
 * A response whose body opens, says something, and then never ends —
 * a queued OpenRouter request (`: OPENROUTER PROCESSING`) or a model
 * still thinking about its first token. `stalled` resolves once the
 * first chunk has been handed over, so a test can act mid-stream.
 */
function stallingStreamResponse(preamble: string): {
  response: () => Response;
  firstChunkRead: Promise<void>;
} {
  let seen = () => {};
  const firstChunkRead = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(preamble));
      // Never closed and never enqueued again: the socket is open and
      // the route is thinking.
      setTimeout(seen, 0);
    },
  });
  return {
    response: () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    firstChunkRead,
  };
}

function streamResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers the calls in order and records the bodies sent. */
function scriptedFetch(responses: readonly (() => Response)[]): {
  fetchImpl: typeof fetch;
  bodies: () => Record<string, unknown>[];
  calls: () => number;
} {
  const sent: Record<string, unknown>[] = [];
  let index = 0;
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const next = responses[index] ?? responses[responses.length - 1];
    index += 1;
    return next!();
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    bodies: () => sent,
    calls: () => index,
  };
}

describe("runProviderContractProbe", () => {
  it("proves support from one forced, streamed native tool call", async () => {
    const script = scriptedFetch([() => streamResponse(TOOL_CALL_STREAM)]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.status).toBe("tools_supported");
    expect(result.toolChoiceMode).toBe("required_named");
    expect(result.probedModel).toBe("vendor/some-model");
    // A healthy route costs exactly one request: no probe ladder, and
    // nothing that could run per turn.
    expect(script.calls()).toBe(1);
    expect(result.requests).toBe(1);

    const body = script.bodies()[0]!;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("vendor/some-model");
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: CONTRACT_PROBE_TOOL_NAME },
    });
    expect(JSON.stringify(body.tools)).toContain(CONTRACT_PROBE_TOOL_NAME);
  });

  it("reports a forced tool choice the route refuses but tools it accepts", async () => {
    const script = scriptedFetch([
      () => errorResponse(400, { error: "tool_choice of type function is not supported" }),
      () => streamResponse(TOOL_CALL_STREAM),
    ]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.status).toBe("forced_tool_choice_rejected");
    expect(result.httpStatus).toBe(400);
    expect(script.calls()).toBe(2);
    expect(script.bodies()[1]!.tool_choice).toBe("auto");
  });

  it("calls a plain text answer under auto inconclusive, not unsupported", async () => {
    const script = scriptedFetch([
      () => errorResponse(400, { error: "unexpected parameter" }),
      () => streamResponse(TEXT_STREAM),
    ]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.status).toBe("inconclusive_no_tool_call");
    expect(result.toolChoiceMode).toBe("auto");
  });

  it("proves the tools payload is the problem by answering without it", async () => {
    // Endpoint success with no tools, refusal with them: the route works,
    // and it is specifically `tools` it will not take.
    const script = scriptedFetch([
      () => errorResponse(400, "Bad Request"),
      () => errorResponse(400, "Bad Request"),
      () => streamResponse(TEXT_STREAM),
    ]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.status).toBe("tools_payload_rejected");
    expect(script.calls()).toBe(3);
    // The control request is the same streamed completion minus tools.
    const control = script.bodies()[2]!;
    expect(control.stream).toBe(true);
    expect(control.tools).toBeUndefined();
    expect(control.tool_choice).toBeUndefined();
  });

  it("blames the route, not tools, when the no-tools control fails too", async () => {
    const script = scriptedFetch([
      () => errorResponse(500, "upstream exploded"),
      () => errorResponse(500, "upstream exploded"),
      () => errorResponse(500, "upstream exploded"),
    ]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.status).toBe("provider_error");
    expect(result.httpStatus).toBe(500);
  });

  it("reports a stream that ended early", async () => {
    const script = scriptedFetch([() => streamResponse(EARLY_EOF_STREAM)]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.status).toBe("stream_early_eof");
    expect(script.calls()).toBe(1);
  });

  it("reports malformed tool-call deltas", async () => {
    const script = scriptedFetch([() => streamResponse(MALFORMED_STREAM)]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.status).toBe("malformed_tool_call");
  });

  it("stops at a quota refusal instead of climbing the ladder", async () => {
    const script = scriptedFetch([
      () => errorResponse(429, { error: { code: "insufficient_quota" } }),
    ]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.status).toBe("quota_or_routing_failed");
    // Nothing another request could add: the account, not the route.
    expect(script.calls()).toBe(1);
  });

  it("stops at an authentication refusal", async () => {
    const script = scriptedFetch([
      () => errorResponse(401, { error: "No auth credentials found" }),
    ]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.status).toBe("endpoint_auth_failed");
    expect(script.calls()).toBe(1);
  });

  it("stops at an unknown model", async () => {
    const script = scriptedFetch([
      () => errorResponse(404, { error: "model not found" }),
    ]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.status).toBe("model_unavailable");
    expect(script.calls()).toBe(1);
  });

  it("reports an unreachable endpoint without claiming anything about tools", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await runProviderContractProbe(TARGET, { fetchImpl });

    expect(result.status).toBe("unreachable");
    expect(result.httpStatus).toBeNull();
  });

  it("keeps credentials and whole response bodies out of the detail", async () => {
    // Both keys sit inside the first 300 characters, so the length cap
    // cannot be what hides them: only redaction can. (The rules
    // themselves are pinned in `redact-provider-detail.test.ts`.)
    const leak =
      `key=${TARGET.apiKey} other=sk-someoneelseskey123 ` + "x".repeat(400);
    const script = scriptedFetch([() => errorResponse(401, leak)]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.detail).not.toContain(TARGET.apiKey);
    expect(result.detail).not.toContain("sk-someoneelseskey123");
    expect(result.detail).toContain("key=***");
    expect(result.detail.length).toBeLessThanOrEqual(300);
  });

  it("refuses to probe with no model rather than inventing one", async () => {
    const script = scriptedFetch([() => streamResponse(TOOL_CALL_STREAM)]);
    const result = await runProviderContractProbe(
      { ...TARGET, model: "  " },
      { fetchImpl: script.fetchImpl },
    );

    expect(result.status).toBe("model_unavailable");
    expect(script.calls()).toBe(0);
  });

  it("reports a cancelled probe as cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const script = scriptedFetch([() => streamResponse(TOOL_CALL_STREAM)]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
      signal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(script.calls()).toBe(0);
  });
  it("sends the token cap a real turn sends", async () => {
    const script = scriptedFetch([() => streamResponse(TOOL_CALL_STREAM)]);
    await runProviderContractProbe(TARGET, { fetchImpl: script.fetchImpl });

    // `buildOpenAiChatBody` puts `max_tokens` on every turn and has no
    // second field to fall back on, so a probe that left it out could
    // pass on a route where every real message 400s.
    expect(script.bodies()[0]!.max_tokens).toBeTypeOf("number");
    expect(script.bodies()[0]!.parallel_tool_calls).toBe(true);
  });

  it("sends the parallel_tool_calls the caller says a turn would send", async () => {
    const script = scriptedFetch([() => streamResponse(TOOL_CALL_STREAM)]);
    await runProviderContractProbe(
      { ...TARGET, parallelToolCalls: false },
      { fetchImpl: script.fetchImpl },
    );

    expect(script.bodies()[0]!.parallel_tool_calls).toBe(false);
  });

  it("reports a rejected token cap instead of retrying with the other field", async () => {
    const script = scriptedFetch([
      () =>
        errorResponse(400, {
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        }),
    ]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    // The turn path has no `max_completion_tokens` fallback, so this is
    // the verdict, not a request to resend: every real turn would be
    // refused the same way.
    expect(result.status).toBe("token_cap_rejected");
    expect(script.calls()).toBe(1);
  });

  it("settles a route that ignores forcing by asking the way a turn asks", async () => {
    const script = scriptedFetch([
      () => streamResponse(TEXT_STREAM),
      () => streamResponse(TOOL_CALL_STREAM),
    ]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    // Rung 1 was accepted and ignored, which says nothing about the
    // mode Atomic runs in. Rung 2 asks in that mode and gets a complete
    // tool call: the route works, and warning about the forced-choice
    // quirk would be warning about a request Atomic never makes.
    expect(result.status).toBe("tools_supported");
    expect(result.toolChoiceMode).toBe("auto");
    expect(script.calls()).toBe(2);
    expect(script.bodies()[1]!.tool_choice).toBe("auto");
  });

  it("reports an ignored forcing when auto declines as well", async () => {
    const script = scriptedFetch([
      () => streamResponse(TEXT_STREAM),
      () => streamResponse(TEXT_STREAM),
    ]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.status).toBe("forced_tool_choice_ignored");
    expect(script.calls()).toBe(2);
  });

  it("does not blame tools when rung 1 streamed and rung 2 failed", async () => {
    const script = scriptedFetch([
      () => streamResponse(TEXT_STREAM),
      () => errorResponse(500, "upstream exploded"),
      () => streamResponse(TEXT_STREAM),
    ]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    // The first rung carried `tools` and streamed, so the no-tools
    // control could not attribute anything to them: spending a third
    // request could only produce a wrong sentence.
    expect(result.status).toBe("provider_error");
    expect(script.calls()).toBe(2);
  });

  it("calls a cap-truncated answer inconclusive, not a route defect", async () => {
    const truncated =
      sseEvent({ choices: [{ delta: { content: "Let me think about" } }] }) +
      sseEvent({ choices: [{ delta: {}, finish_reason: "length" }] }) +
      "data: [DONE]\n\n";
    const script = scriptedFetch([() => streamResponse(truncated)]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    // Our own `max_tokens` ended that answer. Reporting it as "ignored
    // a forced tool choice" would blame the route for our limit.
    expect(result.status).toBe("inconclusive_no_tool_call");
  });

  it("calls its own deadline a timeout, even once bytes have arrived", async () => {
    // OpenRouter's real queue keepalive, then silence. Under the old
    // rule ("timed out with zero bytes") this comment alone turned a
    // slow route into `stream_early_eof` — "turns will end
    // mid-tool-call" — a defect invented by our own budget.
    const stalling = stallingStreamResponse(": OPENROUTER PROCESSING\n\n");
    const script = scriptedFetch([stalling.response]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
      timeoutMs: 250,
    });

    expect(result.status).toBe("timeout");
    expect(script.calls()).toBe(1);
  });

  it("reports an abort that lands mid-stream as cancelled", async () => {
    const stalling = stallingStreamResponse(
      sseEvent({ choices: [{ delta: { content: "thinking" } }] }),
    );
    const script = scriptedFetch([stalling.response]);
    const controller = new AbortController();
    const running = runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    await stalling.firstChunkRead;
    controller.abort();

    // The stream is open and half-read: without the signal in the read
    // race this is a partial body, which classifies as
    // `stream_early_eof` — a route defect we caused by giving up.
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
  });
});
