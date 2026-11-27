import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchHuggingFaceBaseModels,
  fetchHuggingFaceGenerationConfig,
} from "./huggingface-api.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: string) {
  const fn = vi.fn(async () => new Response(body, { status }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("Hugging Face generation_config lookups (ATO-2482)", () => {
  it("reads the card's base_model, string or list, and never the repo itself", async () => {
    answer(200, JSON.stringify({ cardData: { base_model: "Qwen/Qwen3.5-4B" } }));
    expect(await fetchHuggingFaceBaseModels("unsloth/Qwen3.5-4B")).toEqual(["Qwen/Qwen3.5-4B"]);
    answer(200, JSON.stringify({ cardData: { base_model: ["a/b", "x/y", 3, "unsloth/X"] } }));
    expect(await fetchHuggingFaceBaseModels("unsloth/X")).toEqual(["a/b", "x/y"]);
    answer(404, "");
    expect(await fetchHuggingFaceBaseModels("a/b")).toEqual([]);
  });

  it("returns the config text from the resolve URL, or null for 404 and non-JSON", async () => {
    const fn = answer(200, '{"temperature":0.6}');
    expect(await fetchHuggingFaceGenerationConfig("Qwen/Qwen3.5-4B")).toBe('{"temperature":0.6}');
    expect(String((fn.mock.calls[0] as unknown[])[0])).toContain("/Qwen/Qwen3.5-4B/resolve/main/generation_config.json");
    answer(404, "Entry not found");
    expect(await fetchHuggingFaceGenerationConfig("a/b")).toBeNull();
    answer(200, "<html>");
    expect(await fetchHuggingFaceGenerationConfig("a/b")).toBeNull();
  });
});
