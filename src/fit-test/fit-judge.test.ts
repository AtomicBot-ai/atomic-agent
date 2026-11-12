import { describe, expect, it } from "vitest";
import { chatCompletionsUrl, createFitJudge, judgeMessages, parseJudgeVerdict } from "./fit-judge.js";

describe("fit judge", () => {
  it("resolves the chat completions URL from short and long forms", () => {
    expect(chatCompletionsUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(chatCompletionsUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(chatCompletionsUrl("https://h/x/chat/completions")).toBe("https://h/x/chat/completions");
  });

  it("parses a verdict, also one wrapped in text, and clamps the score", () => {
    expect(parseJudgeVerdict('{"score": 4, "reason": "ok"}')).toEqual({ score: 4, reason: "ok" });
    expect(parseJudgeVerdict('Sure. {"score": 9, "reason": "great"} done')).toEqual({ score: 5, reason: "great" });
    expect(parseJudgeVerdict("no idea")).toBeNull();
  });

  it("marks an empty reply in the prompt", () => {
    expect(judgeMessages("p", "  ", "r")[1]!.content).toContain("(empty reply)");
  });

  it("posts to the endpoint with the key and reads the score", async () => {
    let seen: { url: string; auth: string | undefined; body: { model: string } } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) as { model: string } };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"score":3,"reason":"partial"}' } }] }));
    }) as unknown as typeof fetch;
    const judge = createFitJudge({ url: "http://127.0.0.1:9", model: "m", apiKey: "k", fetchImpl });
    expect(await judge("p", "r", "rubric")).toEqual({ score: 3, reason: "partial" });
    expect(seen).toMatchObject({ url: "http://127.0.0.1:9/v1/chat/completions", auth: "Bearer k", body: { model: "m" } });
  });

  it("fails on an HTTP error or a reply without a score", async () => {
    const bad = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    await expect(createFitJudge({ url: "http://h", model: "m", apiKey: null, fetchImpl: bad })("p", "r", "x")).rejects.toThrow(/HTTP 500/);
    const empty = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "hm" } }] }))) as unknown as typeof fetch;
    await expect(createFitJudge({ url: "http://h", model: "m", apiKey: null, fetchImpl: empty })("p", "r", "x")).rejects.toThrow(/no score/);
  });
});
