import { describe, expect, it } from "vitest";

import { accumulateProbeStream } from "./accumulate-probe-stream.js";

function sse(...events: unknown[]): string {
  return events
    .map((event) =>
      typeof event === "string" ? `data: ${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
}

function toolCallChunk(
  parts: { name?: string; arguments?: string; index?: number },
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    model: "probe-model",
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: parts.index ?? 0,
              id: "call_1",
              type: "function",
              function: {
                ...(parts.name !== undefined ? { name: parts.name } : {}),
                ...(parts.arguments !== undefined ? { arguments: parts.arguments } : {}),
              },
            },
          ],
        },
        ...(finishReason ? { finish_reason: finishReason } : {}),
      },
    ],
  };
}

describe("accumulateProbeStream", () => {
  it("assembles a native tool call split across deltas", () => {
    const observation = accumulateProbeStream(
      sse(
        toolCallChunk({ name: "atomic_contract_probe", arguments: '{"ok"' }),
        toolCallChunk({ arguments: ":true}" }),
        toolCallChunk({}, "tool_calls"),
        "[DONE]",
      ),
    );
    expect(observation.toolCalls).toEqual([
      { index: 0, name: "atomic_contract_probe", arguments: '{"ok":true}' },
    ]);
    expect(observation.sawToolCallDelta).toBe(true);
    expect(observation.terminalObserved).toBe(true);
    expect(observation.finishReason).toBe("tool_calls");
  });

  it("keeps a tool-call delta that never carried a function name", () => {
    // The production stream consumer drops this call, because a nameless
    // call cannot be dispatched. The probe has to see it: "deltas came
    // but assembled into nothing" is the diagnosis, and a probe that
    // dropped it would report the far friendlier "no tool call".
    const observation = accumulateProbeStream(
      sse(toolCallChunk({ arguments: '{"ok":true}' }), toolCallChunk({}, "tool_calls")),
    );
    expect(observation.sawToolCallDelta).toBe(true);
    expect(observation.toolCalls[0]?.name).toBe("");
  });

  it("does not mistake a repeated whole name for fragments", () => {
    // Anthropic-compatible endpoints resend the full name every delta.
    const observation = accumulateProbeStream(
      sse(
        toolCallChunk({ name: "atomic_contract_probe", arguments: "{" }),
        toolCallChunk({ name: "atomic_contract_probe", arguments: "}" }),
        toolCallChunk({}, "tool_calls"),
      ),
    );
    expect(observation.toolCalls[0]?.name).toBe("atomic_contract_probe");
  });

  it("collects plain assistant text and its finish reason", () => {
    const observation = accumulateProbeStream(
      sse(
        { choices: [{ delta: { content: "I can " } }] },
        { choices: [{ delta: { content: "help." }, finish_reason: "stop" }] },
        "[DONE]",
      ),
    );
    expect(observation.text).toBe("I can help.");
    expect(observation.sawToolCallDelta).toBe(false);
    expect(observation.terminalObserved).toBe(true);
  });

  it("reports no terminal signal when the body simply stops", () => {
    const observation = accumulateProbeStream(
      sse(toolCallChunk({ name: "atomic_contract_probe", arguments: '{"ok"' })),
    );
    expect(observation.terminalObserved).toBe(false);
    expect(observation.finishReason).toBeNull();
  });

  it("reads a final event that has no trailing blank line", () => {
    // Providers and proxies close the response right after the terminal
    // event often enough that treating it as noise would turn healthy
    // routes into false early-EOF reports.
    const observation = accumulateProbeStream(
      `${sse({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}data: [DONE]`,
    );
    expect(observation.terminalObserved).toBe(true);
  });

  it("survives a truncated JSON payload without inventing content", () => {
    const observation = accumulateProbeStream(
      `${sse({ choices: [{ delta: { content: "hi" } }] })}data: {"choices":[{"delta":{"too`,
    );
    expect(observation.text).toBe("hi");
    expect(observation.terminalObserved).toBe(false);
  });
});
