import { describe, expect, it } from "vitest";

import { accumulateProbeStream } from "./accumulate-probe-stream.js";
import {
  classifyContractProbeHttpFailure,
  classifyProbeStream,
  contractProbeFailureIsTerminal,
} from "./classify-contract-probe.js";
import {
  CONTRACT_PROBE_TOOL_NAME,
  contractProbeFoundDefect,
  contractProbeProvesToolSupport,
  contractProbeToolDefinition,
} from "./contract-probe-types.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../../prompt/tool-descriptors.js";

function stream(body: string): ReturnType<typeof accumulateProbeStream> {
  return accumulateProbeStream(body);
}

const CALL_EVENT =
  `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: CONTRACT_PROBE_TOOL_NAME, arguments: '{"ok":true}' },
            },
          ],
        },
      },
    ],
  })}\n\n`;
const FINISH_EVENT = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;

describe("classifyContractProbeHttpFailure", () => {
  it("names an authentication refusal", () => {
    expect(
      classifyContractProbeHttpFailure(401, '{"error":"No auth credentials found"}'),
    ).toBe("endpoint_auth_failed");
  });

  it("buckets quota exhaustion and gateway throttling together", () => {
    expect(
      classifyContractProbeHttpFailure(429, '{"error":{"code":"insufficient_quota"}}'),
    ).toBe("quota_or_routing_failed");
    expect(classifyContractProbeHttpFailure(402, "Insufficient credits")).toBe(
      "quota_or_routing_failed",
    );
    expect(classifyContractProbeHttpFailure(429, "slow down")).toBe(
      "quota_or_routing_failed",
    );
  });

  it("names an unknown model", () => {
    expect(classifyContractProbeHttpFailure(404, "no such model")).toBe(
      "model_unavailable",
    );
    expect(
      classifyContractProbeHttpFailure(400, '{"error":"model does not exist"}'),
    ).toBe("model_unavailable");
  });

  it("leaves an unexplained 400 open rather than blaming tools", () => {
    // This is the case the ladder exists for: a bare 400 with `tools` in
    // the body proves nothing on its own, and guessing from wording is
    // exactly what makes a diagnosis wrong.
    expect(classifyContractProbeHttpFailure(400, "Bad Request")).toBe("provider_error");
    expect(contractProbeFailureIsTerminal("provider_error")).toBe(false);
  });

  it("treats key, quota and model refusals as terminal", () => {
    expect(contractProbeFailureIsTerminal("endpoint_auth_failed")).toBe(true);
    expect(contractProbeFailureIsTerminal("quota_or_routing_failed")).toBe(true);
    expect(contractProbeFailureIsTerminal("model_unavailable")).toBe(true);
  });
});

describe("classifyProbeStream", () => {
  it("accepts one complete native tool call", () => {
    expect(
      classifyProbeStream(stream(CALL_EVENT + FINISH_EVENT), "required_named"),
    ).toBe("tools_supported");
  });

  it("accepts a forced call that carried no arguments", () => {
    // The synthetic schema requires no field, so empty arguments are a
    // legal answer; calling them malformed would fail healthy routes.
    const empty = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                type: "function",
                function: { name: CONTRACT_PROBE_TOOL_NAME, arguments: "" },
              },
            ],
          },
        },
      ],
    })}\n\n`;
    expect(classifyProbeStream(stream(empty + FINISH_EVENT), "required_named")).toBe(
      "tools_supported",
    );
  });

  it("calls a text answer under auto inconclusive, never unsupported", () => {
    const text = `data: ${JSON.stringify({
      choices: [{ delta: { content: "Sure!" }, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`;
    expect(classifyProbeStream(stream(text), "auto")).toBe(
      "inconclusive_no_tool_call",
    );
  });

  it("calls the same text answer under a forced choice a route defect", () => {
    const text = `data: ${JSON.stringify({
      choices: [{ delta: { content: "Sure!" }, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`;
    expect(classifyProbeStream(stream(text), "required_named")).toBe(
      "forced_tool_choice_ignored",
    );
  });

  it("reports a stream that ended before announcing it was done", () => {
    // A complete-looking call in a truncated body is not trustworthy:
    // argument fragments may still have been in flight.
    expect(classifyProbeStream(stream(CALL_EVENT), "required_named")).toBe(
      "stream_early_eof",
    );
  });

  it("reports arguments that are not JSON", () => {
    const truncated = `data: ${JSON.stringify({
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
    })}\n\n`;
    expect(classifyProbeStream(stream(truncated + FINISH_EVENT), "required_named")).toBe(
      "malformed_tool_call",
    );
  });

  it("reports tool-call deltas that never named a function", () => {
    const nameless = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, type: "function", function: { arguments: "{}" } }],
          },
        },
      ],
    })}\n\n`;
    expect(classifyProbeStream(stream(nameless + FINISH_EVENT), "required_named")).toBe(
      "malformed_tool_call",
    );
  });

  it("reports a call naming a function that was never offered", () => {
    const wrong = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                type: "function",
                function: { name: "os.fs.read", arguments: "{}" },
              },
            ],
          },
        },
      ],
    })}\n\n`;
    expect(classifyProbeStream(stream(wrong + FINISH_EVENT), "required_named")).toBe(
      "malformed_tool_call",
    );
  });
});

describe("the synthetic probe tool", () => {
  it("is not a tool this agent can dispatch", () => {
    // The probe reads the call and throws it away; nothing dispatches
    // it. This pins the other half of that promise: the name cannot
    // collide with a real tool, now or after the catalog grows.
    const registered = DEFAULT_TOOL_DESCRIPTORS.map((d) => d.name);
    expect(registered).not.toContain(CONTRACT_PROBE_TOOL_NAME);
  });

  it("offers a schema with no required field", () => {
    const fn = (contractProbeToolDefinition().function ?? {}) as {
      name: string;
      parameters: { required: string[] };
    };
    expect(fn.name).toBe(CONTRACT_PROBE_TOOL_NAME);
    expect(fn.parameters.required).toEqual([]);
  });

  it("treats only a complete tool call as proven support", () => {
    expect(contractProbeProvesToolSupport("tools_supported")).toBe(true);
    for (const status of [
      "inconclusive_no_tool_call",
      "stream_early_eof",
      "malformed_tool_call",
      "tools_payload_rejected",
      "provider_error",
    ] as const) {
      expect(contractProbeProvesToolSupport(status)).toBe(false);
    }
  });

  it("does not count an inconclusive auto answer as a defect", () => {
    expect(contractProbeFoundDefect("inconclusive_no_tool_call")).toBe(false);
    expect(contractProbeFoundDefect("stream_early_eof")).toBe(true);
  });
});
