import { describe, expect, it, vi } from "vitest";

import {
  buildJudgeMessages,
  createSkillEvalJudge,
  DEFAULT_JUDGE_BASE_URL,
  DEFAULT_JUDGE_MODEL,
  parseJudgeVerdict,
  resolveJudgeConfig,
} from "./judge.js";

describe("resolveJudgeConfig", () => {
  it("defaults to OpenRouter with the harness model and needs a key there", () => {
    expect(resolveJudgeConfig({}, {})).toEqual({ error: expect.stringContaining("needs an API key") });
    expect(resolveJudgeConfig({}, { OPENROUTER_API_KEY: "k" })).toEqual({
      baseUrl: DEFAULT_JUDGE_BASE_URL,
      model: DEFAULT_JUDGE_MODEL,
      apiKey: "k",
      timeoutMs: 60_000,
    });
  });

  it("takes flags over the environment, and a local URL needs no key", () => {
    const config = resolveJudgeConfig(
      { url: "http://127.0.0.1:8080/", model: "flag-model" },
      { ATOMIC_AGENT_JUDGE_URL: "https://elsewhere.example/v1", ATOMIC_AGENT_JUDGE_MODEL: "env-model", ATOMIC_AGENT_JUDGE_TIMEOUT_MS: "5000" },
    );
    expect(config).toEqual({ baseUrl: "http://127.0.0.1:8080", model: "flag-model", apiKey: null, timeoutMs: 5000 });
  });

  it("reads the harness's own key variable too", () => {
    expect(resolveJudgeConfig({}, { ATOMIC_AGENT_JUDGE_API_KEY: "legacy" })).toMatchObject({ apiKey: "legacy" });
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
  it("posts to chat/completions with the key and reads the verdict", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"score":5,"reason":"exact"}' } }] }), { status: 200 }),
    );
    const judge = createSkillEvalJudge(
      { baseUrl: "https://openrouter.ai/api/v1", model: "m", apiKey: "k", timeoutMs: 1000 },
      fetchImpl as unknown as typeof fetch,
    );
    const verdict = await judge.score({ prompt: "p", reply: "r", rubric: "q", reference: null });
    expect(verdict).toEqual({ score: 5, reason: "exact", parseFallback: false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "m", temperature: 0 });
  });

  it("adds /v1 to a bare local server URL and throws on an HTTP error", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const judge = createSkillEvalJudge(
      { baseUrl: "http://127.0.0.1:8080", model: "m", apiKey: null, timeoutMs: 1000 },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(judge.score({ prompt: "p", reply: "r", rubric: "q", reference: null })).rejects.toThrow("judge HTTP 503: down");
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("http://127.0.0.1:8080/v1/chat/completions");
  });
});
