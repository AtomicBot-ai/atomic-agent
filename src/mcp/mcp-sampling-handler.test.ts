import { describe, expect, it, vi } from "vitest";

import type {
  CompletionRequest,
  CompletionResult,
  LlamaServerClient,
} from "../llm/llama-server-client.js";

import { createMcpSamplingHandler } from "./mcp-sampling-handler.js";

function makeFakeLlama(
  complete: (req: CompletionRequest) => Promise<CompletionResult>,
): LlamaServerClient {
  return { complete } as unknown as LlamaServerClient;
}

function defaultResult(content = "answer"): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptTokens: 5, predictedTokens: 3 } as CompletionResult["timing"],
    cacheHitTokens: 0,
    slotId: -1,
    modelId: "test-model",
  };
}

describe("createMcpSamplingHandler", () => {
  it("INVARIANT 1 — always uses slotId: -1 and disables cache_prompt", async () => {
    const spy = vi.fn(async () => defaultResult());
    const handler = createMcpSamplingHandler({
      llamaServerClient: makeFakeLlama(spy),
      server: "github",
    });
    const ctrl = new AbortController();
    await handler(
      {
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      },
      ctrl.signal,
    );
    expect(spy).toHaveBeenCalledOnce();
    const req = spy.mock.calls[0]![0];
    expect(req.slotId).toBe(-1);
    expect(req.cachePrompt).toBe(false);
  });

  it("flattens system prompt + multi-turn messages into a single prompt", async () => {
    const spy = vi.fn(async () => defaultResult());
    const handler = createMcpSamplingHandler({
      llamaServerClient: makeFakeLlama(spy),
      server: "*",
    });
    await handler(
      {
        systemPrompt: "be terse",
        messages: [
          { role: "user", content: { type: "text", text: "ping" } },
          { role: "assistant", content: { type: "text", text: "pong" } },
          { role: "user", content: { type: "text", text: "again" } },
        ],
      },
      new AbortController().signal,
    );
    const prompt = spy.mock.calls[0]![0].prompt;
    expect(prompt).toContain("system: be terse");
    expect(prompt).toContain("user: ping");
    expect(prompt).toContain("assistant: pong");
    expect(prompt).toContain("user: again");
    expect(prompt.endsWith("assistant:")).toBe(true);
  });

  it("clamps maxTokens to the documented ceiling (4096) and respects the default", async () => {
    const spy = vi.fn(async () => defaultResult());
    const handler = createMcpSamplingHandler({
      llamaServerClient: makeFakeLlama(spy),
      server: "*",
    });
    await handler(
      {
        maxTokens: 999_999,
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      },
      new AbortController().signal,
    );
    expect(spy.mock.calls[0]![0].maxTokens).toBe(4_096);

    spy.mockClear();
    await handler(
      { messages: [{ role: "user", content: { type: "text", text: "hi" } }] },
      new AbortController().signal,
    );
    expect(spy.mock.calls[0]![0].maxTokens).toBe(512);
  });

  it("forwards temperature when provided and defaults to 0.7", async () => {
    const spy = vi.fn(async () => defaultResult());
    const handler = createMcpSamplingHandler({
      llamaServerClient: makeFakeLlama(spy),
      server: "*",
    });
    await handler(
      {
        temperature: 0.2,
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      },
      new AbortController().signal,
    );
    expect(spy.mock.calls[0]![0].temperature).toBe(0.2);

    spy.mockClear();
    await handler(
      { messages: [{ role: "user", content: { type: "text", text: "hi" } }] },
      new AbortController().signal,
    );
    expect(spy.mock.calls[0]![0].temperature).toBe(0.7);
  });

  it("throws when the signal is already aborted (does not call LLM)", async () => {
    const spy = vi.fn(async () => defaultResult());
    const handler = createMcpSamplingHandler({
      llamaServerClient: makeFakeLlama(spy),
      server: "*",
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      handler(
        { messages: [{ role: "user", content: { type: "text", text: "hi" } }] },
        ctrl.signal,
      ),
    ).rejects.toThrow(/aborted/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("packages the completion as an MCP CreateMessageResult", async () => {
    const handler = createMcpSamplingHandler({
      llamaServerClient: makeFakeLlama(async () => defaultResult("hello world")),
      server: "*",
    });
    const result = await handler(
      { messages: [{ role: "user", content: { type: "text", text: "hi" } }] },
      new AbortController().signal,
    );
    expect(result.role).toBe("assistant");
    expect(result.model).toBe("test-model");
    expect(result.stopReason).toBe("endTurn");
    expect(result.content).toEqual({ type: "text", text: "hello world" });
  });
});
