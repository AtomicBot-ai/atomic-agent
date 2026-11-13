import { describe, expect, it, vi } from "vitest";

import type { LlmProvider } from "../../llm/provider/llm-provider.js";
import {
  buildJudgeMessages,
  createSkillEvalJudge,
  parseJudgeVerdict,
  resolveJudgeConfig,
} from "./judge.js";

const llm = {
  activeTextProvider: "local-llama",
  providers: [
    { id: "local-llama", kind: "llama-server" },
    { id: "cloud-a", kind: "openrouter", model: "a-model" },
    { id: "cloud-b", kind: "openai-compatible", defaultChatModel: "b-model" },
  ],
};

describe("resolveJudgeConfig", () => {
  it("has no built-in paid default: a local model and nothing set is an error", () => {
    expect(resolveJudgeConfig({}, llm, null, {})).toEqual({ error: expect.stringContaining("there is no judge: the active model is local") });
    expect(resolveJudgeConfig({}, llm, null, { OPENROUTER_API_KEY: "k" })).toEqual({ error: expect.stringContaining("skills.eval.judgeProvider") });
  });

  it("uses skills.eval.judgeProvider when set", () => {
    expect(resolveJudgeConfig({}, llm, "cloud-b", {})).toEqual({
      kind: "provider", providerId: "cloud-b", model: "b-model", source: "judgeProvider", timeoutMs: 60_000,
    });
  });

  it("refuses an unknown judgeProvider and the local model under test", () => {
    expect(resolveJudgeConfig({}, llm, "nope", {})).toEqual({ error: expect.stringContaining('"nope" is not one of your providers') });
    expect(resolveJudgeConfig({}, llm, "local-llama", {})).toEqual({ error: expect.stringContaining("the one under test") });
  });

  it("falls back to the active text provider when it is a cloud one", () => {
    expect(resolveJudgeConfig({}, { ...llm, activeTextProvider: "cloud-a" }, null, {})).toMatchObject({
      kind: "provider", providerId: "cloud-a", model: "a-model", source: "active",
    });
  });

  it("an explicit URL wins, needs a model, and a hosted one needs a key", () => {
    expect(resolveJudgeConfig({ url: "http://127.0.0.1:8080/" }, llm, "cloud-b", {})).toEqual({ error: expect.stringContaining("needs a model") });
    expect(
      resolveJudgeConfig(
        { url: "http://127.0.0.1:8080/", model: "flag-model" },
        llm,
        "cloud-b",
        { ATOMIC_AGENT_JUDGE_MODEL: "env-model", ATOMIC_AGENT_JUDGE_TIMEOUT_MS: "5000" },
      ),
    ).toEqual({ kind: "http", baseUrl: "http://127.0.0.1:8080", model: "flag-model", apiKey: null, timeoutMs: 5000 });
    expect(resolveJudgeConfig({}, llm, null, { ATOMIC_AGENT_JUDGE_URL: "https://judge.example/v1", ATOMIC_AGENT_JUDGE_MODEL: "m" })).toEqual({
      error: expect.stringContaining("needs an API key"),
    });
    expect(
      resolveJudgeConfig({}, llm, null, { ATOMIC_AGENT_JUDGE_URL: "https://judge.example/v1", ATOMIC_AGENT_JUDGE_MODEL: "m", ATOMIC_AGENT_JUDGE_API_KEY: "k" }),
    ).toMatchObject({ kind: "http", apiKey: "k" });
  });
});

describe("parseJudgeVerdict", () => {
  it("reads clean JSON and clamps the score", () => {
    expect(parseJudgeVerdict('{"score": 4, "reason": "fine"}')).toEqual({ score: 4, reason: "fine", parseFallback: false });
    expect(parseJudgeVerdict('{"score": 9}').score).toBe(5);
  });

  it("finds the JSON inside surrounding text", () => {
    expect(parseJudgeVerdict('Sure! {"score": "3", "reason": "partial"} done')).toMatchObject({ score: 3, parseFallback: false });
  });

  it("falls back to 1 when nothing can be read", () => {
    expect(parseJudgeVerdict("I think it is good")).toMatchObject({ score: 1, parseFallback: true });
  });
});

describe("buildJudgeMessages", () => {
  it("puts the task, reply, reference and rubric in the user message", () => {
    const [system, user] = buildJudgeMessages({ prompt: "Summarize", reply: "", rubric: "Mentions X", reference: "X happened" });
    expect(system!.role).toBe("system");
    expect(user!.content).toContain("== TASK GIVEN TO ASSISTANT ==\nSummarize");
    expect(user!.content).toContain("(empty reply)");
    expect(user!.content).toContain("== REFERENCE ANSWER ==\nX happened");
    expect(user!.content).toContain("== RUBRIC ==\nMentions X");
  });

  it("leaves the reference block out when there is none", () => {
    const [, user] = buildJudgeMessages({ prompt: "p", reply: "r", rubric: "q", reference: null });
    expect(user!.content).not.toContain("REFERENCE");
  });
});

describe("createSkillEvalJudge", () => {
  it("a provider judge calls that provider, reads the emitted verdict and counts its usage", async () => {
    const complete = vi.fn(async () => ({
      content: "",
      toolCalls: [{ id: "1", type: "function", function: { name: "emit_verdict", arguments: '{"score":4,"reason":"good"}' } }],
      usage: { promptTokens: 300, completionTokens: 20, totalTokens: 320 },
      modelId: "b-model",
    }));
    const provider = { id: "cloud-b", chatModelId: "b-model", complete } as unknown as LlmProvider;
    const priceUsage = vi.fn(() => 0.002);
    const judge = createSkillEvalJudge(
      { kind: "provider", providerId: "cloud-b", model: "b-model", source: "judgeProvider", timeoutMs: 1000 },
      { provider, priceUsage },
    );
    expect(judge.providerId).toBe("cloud-b");
    expect(judge.model).toBe("b-model");
    expect(await judge.score({ prompt: "p", reply: "r", rubric: "q", reference: null })).toEqual({ score: 4, reason: "good", parseFallback: false });
    const request = (complete.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(request.prompt).toContain("== RUBRIC ==\nq");
    expect(request.temperature).toBe(0);
    expect(priceUsage).toHaveBeenCalledWith(expect.objectContaining({ promptTokens: 300 }), "b-model");
    expect(judge.usage()).toEqual({ calls: 1, promptTokens: 300, completionTokens: 20, totalTokens: 320, costUsd: 0.002 });
  });

  it("prefers the service's own bill and reports null cost when nothing priced it", async () => {
    const replies = [
      { content: '{"score":5,"reason":"x"}', usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, costUsd: 0.5 }, modelId: null },
      { content: '{"score":2,"reason":"y"}', modelId: null },
    ];
    const provider = { id: "c", complete: vi.fn(async () => replies.shift()) } as unknown as LlmProvider;
    const billed = createSkillEvalJudge({ kind: "provider", providerId: "c", model: null, source: "active", timeoutMs: 1000 }, { provider, priceUsage: () => 99 });
    await billed.score({ prompt: "p", reply: "r", rubric: "q", reference: null });
    await billed.score({ prompt: "p", reply: "r", rubric: "q", reference: null });
    expect(billed.usage()).toEqual({ calls: 2, promptTokens: 10, completionTokens: 1, totalTokens: 11, costUsd: 0.5 });
    const unpriced = createSkillEvalJudge({ kind: "provider", providerId: "c", model: null, source: "active", timeoutMs: 1000 }, {
      provider: { id: "c", complete: async () => ({ content: '{"score":3}', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, modelId: null }) } as unknown as LlmProvider,
    });
    await unpriced.score({ prompt: "p", reply: "r", rubric: "q", reference: null });
    expect(unpriced.usage().costUsd).toBeNull();
  });

  it("an http judge posts to chat/completions with the key, reads the verdict and its usage", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"score":5,"reason":"exact"}' } }], usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.001 } }), { status: 200 }),
    );
    const judge = createSkillEvalJudge(
      { kind: "http", baseUrl: "https://judge.example/v1", model: "m", apiKey: "k", timeoutMs: 1000 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const verdict = await judge.score({ prompt: "p", reply: "r", rubric: "q", reference: null });
    expect(verdict).toEqual({ score: 5, reason: "exact", parseFallback: false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://judge.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(judge.usage()).toEqual({ calls: 1, promptTokens: 50, completionTokens: 5, totalTokens: 55, costUsd: 0.001 });
  });

  it("adds /v1 to a bare local server URL and throws on an HTTP error", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const judge = createSkillEvalJudge(
      { kind: "http", baseUrl: "http://127.0.0.1:8080", model: "m", apiKey: null, timeoutMs: 1000 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await expect(judge.score({ prompt: "p", reply: "r", rubric: "q", reference: null })).rejects.toThrow("judge HTTP 503: down");
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("http://127.0.0.1:8080/v1/chat/completions");
  });
});
