import { describe, expect, it } from "vitest";

import { firstModelId, localModelProbeMessage, probeLocalModel } from "./launch-local-model.js";

const answer = (status: number, body: unknown = {}) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("local model probe (ATO-2447)", () => {
  it("reads the model id from OpenAI and llama-server shapes", () => {
    expect(firstModelId({ data: [{ id: "qwen3-coder" }] })).toBe("qwen3-coder");
    expect(firstModelId({ models: [{ name: "gemma", model: "gemma.gguf" }] })).toBe("gemma.gguf");
    expect(firstModelId({ data: [] })).toBeNull();
    expect(firstModelId(null)).toBeNull();
  });

  it("asks /local/v1/models with the key and maps each answer", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get("authorization") };
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await probeLocalModel("http://127.0.0.1:9", "k", spy)).toEqual({ ok: true, modelId: "m1" });
    expect(seen).toEqual({ url: "http://127.0.0.1:9/local/v1/models", auth: "Bearer k" });
    expect(await probeLocalModel("http://x", "k", answer(401))).toEqual({ ok: false, reason: "auth" });
    expect(await probeLocalModel("http://x", "k", answer(404))).toEqual({ ok: false, reason: "no_route" });
    expect(await probeLocalModel("http://x", "k", answer(502))).toEqual({ ok: false, reason: "not_running" });
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await probeLocalModel("http://x", "k", down)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("tells the person what to do, never a raw status", () => {
    expect(localModelProbeMessage("not_running", 8787)).toContain("atag models start");
    expect(localModelProbeMessage("no_route", 8787)).toContain("port 8787");
    expect(localModelProbeMessage("auth", 8787)).not.toMatch(/40[13]/);
  });
});
