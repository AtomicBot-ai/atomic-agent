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
    const leak = `${"x".repeat(400)} key=${TARGET.apiKey} other=sk-someoneelseskey123`;
    const script = scriptedFetch([() => errorResponse(401, leak)]);
    const result = await runProviderContractProbe(TARGET, {
      fetchImpl: script.fetchImpl,
    });

    expect(result.detail).not.toContain(TARGET.apiKey);
    expect(result.detail).not.toContain("sk-someoneelseskey123");
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
});
