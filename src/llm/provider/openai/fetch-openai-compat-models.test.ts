import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchOpenAiCompatModels,
  getCachedOpenAiCompatModels,
  normalizeOpenAiCompatBaseUrl,
} from "./fetch-openai-compat-models.js";

describe("fetchOpenAiCompatModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips trailing slashes and an explicit /v1 from the base url", () => {
    expect(normalizeOpenAiCompatBaseUrl(" https://vllm.example/v1/ ")).toBe(
      "https://vllm.example",
    );
    expect(normalizeOpenAiCompatBaseUrl("https://vllm.example")).toBe(
      "https://vllm.example",
    );
  });

  it("lists sorted model ids, sends the bearer key, and caches per base url", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        data: [{ id: "zephyr" }, { id: "Qwen/Qwen3-8B" }, { id: 42 }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const ids = await fetchOpenAiCompatModels("https://vllm.example/v1", "key");
    expect(ids).toEqual(["Qwen/Qwen3-8B", "zephyr"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://vllm.example/v1/models");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer key" },
    });

    expect(getCachedOpenAiCompatModels("https://vllm.example/")).toEqual(ids);
    await fetchOpenAiCompatModels("https://vllm.example", "key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a rejected request so callers can fall back to typing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401 })),
    );
    await expect(
      fetchOpenAiCompatModels("https://locked.example"),
    ).rejects.toThrow("http 401");
    expect(getCachedOpenAiCompatModels("https://locked.example")).toBeUndefined();
  });
});
