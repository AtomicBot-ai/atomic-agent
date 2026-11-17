import { describe, expect, it, vi } from "vitest";
import { createEmptySessionState, type SessionState } from "./index.js";
import {
  chatCompletionText,
  chatCompletionsUrl,
  generateNextStepViaEndpoint,
  readNextStepEndpoint,
} from "./next-step-endpoint.js";

function answered(): SessionState {
  return {
    ...createEmptySessionState({ id: "s-1", workingDir: "/w" }),
    turnCount: 1,
    turns: [
      { kind: "user", text: "write a parser for the csv export", at: 1 },
      { kind: "assistant_reply", text: "Done: parser.ts reads the export.", at: 2 },
    ],
  };
}

function reply(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
}

describe("chatCompletionsUrl", () => {
  it("accepts a bare host, a /v1 base or the full route", () => {
    expect(chatCompletionsUrl("http://127.0.0.1:8081")).toBe("http://127.0.0.1:8081/v1/chat/completions");
    expect(chatCompletionsUrl("http://127.0.0.1:8081/v1/")).toBe("http://127.0.0.1:8081/v1/chat/completions");
    expect(chatCompletionsUrl("http://localhost:1234/v1/chat/completions")).toBe("http://localhost:1234/v1/chat/completions");
    expect(chatCompletionsUrl("http://localhost:11434/api/v1")).toBe("http://localhost:11434/api/v1/chat/completions");
  });

  it("refuses anything that is not http(s)", () => {
    expect(chatCompletionsUrl("file:///etc/passwd")).toBeNull();
    expect(chatCompletionsUrl("127.0.0.1:8081")).toBeNull();
    expect(chatCompletionsUrl("not a url")).toBeNull();
  });
});

describe("readNextStepEndpoint", () => {
  it("is null without the URL variable or with a bad one", () => {
    expect(readNextStepEndpoint({})).toBeNull();
    expect(readNextStepEndpoint({ ATOMIC_AGENT_NEXT_STEP_URL: "  " })).toBeNull();
    expect(readNextStepEndpoint({ ATOMIC_AGENT_NEXT_STEP_URL: "ftp://x" })).toBeNull();
  });

  it("reads URL, model and key", () => {
    expect(
      readNextStepEndpoint({
        ATOMIC_AGENT_NEXT_STEP_URL: "http://127.0.0.1:8081/v1",
        ATOMIC_AGENT_NEXT_STEP_MODEL: " qwen3.5-0.8b ",
        ATOMIC_AGENT_NEXT_STEP_API_KEY: "k",
      }),
    ).toEqual({ url: "http://127.0.0.1:8081/v1/chat/completions", model: "qwen3.5-0.8b", apiKey: "k" });
    expect(readNextStepEndpoint({ ATOMIC_AGENT_NEXT_STEP_URL: "http://127.0.0.1:8081" })).toEqual({
      url: "http://127.0.0.1:8081/v1/chat/completions",
      model: null,
      apiKey: null,
    });
  });
});

describe("chatCompletionText", () => {
  it("takes the first choice's content and nothing else", () => {
    expect(chatCompletionText({ choices: [{ message: { content: "hi" } }] })).toBe("hi");
    expect(chatCompletionText({ choices: [] })).toBe("");
    expect(chatCompletionText(null)).toBe("");
    expect(chatCompletionText({ choices: [{ message: { content: null, reasoning_content: "x" } }] })).toBe("");
  });
});

describe("generateNextStepViaEndpoint", () => {
  const endpoint = { url: "http://127.0.0.1:8081/v1/chat/completions", model: "small", apiKey: "secret" };

  it("sends the same prompt as the chat-model path and cleans the answer", async () => {
    const fetchImpl = reply({ choices: [{ message: { content: "<think>hm</think>\nNext step: Add tests for the parser" } }] });
    const text = await generateNextStepViaEndpoint(answered(), endpoint, { fetchImpl });
    expect(text).toBe("Add tests for the parser");
    const [, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
    const body = JSON.parse(String(init.body)) as { model: string; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe("small");
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[1]?.content).toContain("write a parser for the csv export");
  });

  it("returns null on NONE, an HTTP error, a thrown fetch, or no exchange", async () => {
    const onError = vi.fn();
    expect(await generateNextStepViaEndpoint(answered(), endpoint, { fetchImpl: reply({ choices: [{ message: { content: "NONE" } }] }) })).toBeNull();
    expect(await generateNextStepViaEndpoint(answered(), endpoint, { fetchImpl: reply({}, false, 500), onError })).toBeNull();
    const throwing = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await generateNextStepViaEndpoint(answered(), endpoint, { fetchImpl: throwing, onError })).toBeNull();
    expect(onError).toHaveBeenCalledTimes(2);
    const empty = createEmptySessionState({ id: "s-2", workingDir: "/w" });
    const unused = reply({});
    expect(await generateNextStepViaEndpoint(empty, endpoint, { fetchImpl: unused })).toBeNull();
    expect(unused).not.toHaveBeenCalled();
  });
});
