import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchOpenAiCompatModels,
  getCachedOpenAiCompatModels,
  getCachedOpenAiCompatModelsForBaseUrl,
} from "./fetch-openai-compat-models.js";

describe("fetchOpenAiCompatModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

    expect(getCachedOpenAiCompatModels("https://vllm.example/", "key")).toEqual(ids);
    await fetchOpenAiCompatModels("https://vllm.example", "key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not serve one key's list to another key", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "m" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchOpenAiCompatModels("https://keyed.example", "first");
    expect(getCachedOpenAiCompatModels("https://keyed.example", "second")).toBeUndefined();
    expect(getCachedOpenAiCompatModels("https://keyed.example")).toBeUndefined();

    await fetchOpenAiCompatModels("https://keyed.example", "second");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("expires the cache after an hour so rotated keys and new models show up", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "m" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchOpenAiCompatModels("https://stale.example", "key");
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(getCachedOpenAiCompatModels("https://stale.example", "key")).toBeUndefined();

    await fetchOpenAiCompatModels("https://stale.example", "key");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves the URL-only lookup from a keyed fetch, but never past the TTL", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "grok-4" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchOpenAiCompatModels("https://panel.example", "secret");
    // The panel knows the base URL but not the key that fetched the list.
    expect(getCachedOpenAiCompatModelsForBaseUrl("https://panel.example/")).toEqual([
      "grok-4",
    ]);

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(
      getCachedOpenAiCompatModelsForBaseUrl("https://panel.example"),
    ).toBeUndefined();
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

  it("rejects a non-ASCII key with a readable reason, never a ByteString crash", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "m" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    // "sk-т" carries a Cyrillic character that cannot sit in a header.
    await expect(
      fetchOpenAiCompatModels("https://byte.example", "sk-т"),
    ).rejects.toThrow(/non-ASCII/);
    // The guard fires before the request, so `fetch` never runs.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
