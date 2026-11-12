import { describe, expect, it, vi } from "vitest";

import {
  OLLAMA_DEFAULT_NUM_CTX,
  effectiveOllamaWindow,
  isOllamaEntry,
  ollamaApiBase,
  parseNumCtxParameter,
  parseOllamaPsContextLength,
  parseOllamaShow,
  readOllamaContextWindow,
} from "./ollama-context-window.js";

const SHOW_BOTH = {
  modelfile: "FROM qwen3:8b\nPARAMETER num_ctx 8192",
  parameters: 'num_ctx                        8192\nstop                           "<|im_end|>"\ntemperature                    0.6',
  model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960, "qwen3.block_count": 36 },
};

const SHOW_LENGTH_ONLY = {
  modelfile: "FROM llama3.1:8b",
  parameters: 'stop                           "<|eot_id|>"',
  model_info: { "general.architecture": "llama", "llama.context_length": 131072 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (route === undefined) return new Response("not found", { status: 404 });
    return route();
  });
}

describe("parseNumCtxParameter", () => {
  it("reads the num_ctx line of the parameters block", () => {
    expect(parseNumCtxParameter(SHOW_BOTH.parameters)).toBe(8192);
    expect(parseNumCtxParameter("temperature 0.7\r\nnum_ctx 16384\r\n")).toBe(16384);
  });

  it("is undefined when absent, implausible or not text", () => {
    expect(parseNumCtxParameter(SHOW_LENGTH_ONLY.parameters)).toBeUndefined();
    expect(parseNumCtxParameter("num_ctx 0")).toBeUndefined();
    expect(parseNumCtxParameter("num_ctx lots")).toBeUndefined();
    expect(parseNumCtxParameter("num_ctx_extra 8192")).toBeUndefined();
    expect(parseNumCtxParameter(undefined)).toBeUndefined();
    expect(parseNumCtxParameter(42)).toBeUndefined();
  });
});

describe("parseOllamaShow", () => {
  it("reads num_ctx and the architecture's context_length", () => {
    expect(parseOllamaShow(SHOW_BOTH)).toEqual({ numCtx: 8192, contextLength: 40960 });
  });

  it("reads context_length alone when the modelfile sets no num_ctx", () => {
    expect(parseOllamaShow(SHOW_LENGTH_ONLY)).toEqual({ contextLength: 131072 });
  });

  it("falls back to any *.context_length key when the architecture is missing", () => {
    expect(parseOllamaShow({ model_info: { "gemma3.context_length": 32768 } })).toEqual({ contextLength: 32768 });
  });

  it("is empty for garbage", () => {
    expect(parseOllamaShow(null)).toEqual({});
    expect(parseOllamaShow("nope")).toEqual({});
    expect(parseOllamaShow([1, 2])).toEqual({});
    expect(parseOllamaShow({ parameters: 7, model_info: "x" })).toEqual({});
    expect(parseOllamaShow({ model_info: { "general.architecture": "llama", "llama.context_length": "big" } })).toEqual({});
  });
});

describe("parseOllamaPsContextLength", () => {
  const ps = {
    models: [
      { name: "llama3.1:latest", model: "llama3.1:latest", context_length: 4096 },
      { name: "qwen3:8b", model: "qwen3:8b", context_length: 32768 },
      { name: "old:latest", model: "old:latest" },
    ],
  };

  it("reads the loaded model's window, matching an untagged name to :latest", () => {
    expect(parseOllamaPsContextLength(ps, "qwen3:8b")).toBe(32768);
    expect(parseOllamaPsContextLength(ps, "llama3.1")).toBe(4096);
  });

  it("is undefined for a model not loaded, an older build, or garbage", () => {
    expect(parseOllamaPsContextLength(ps, "mistral")).toBeUndefined();
    expect(parseOllamaPsContextLength(ps, "old")).toBeUndefined();
    expect(parseOllamaPsContextLength({ models: "x" }, "qwen3:8b")).toBeUndefined();
    expect(parseOllamaPsContextLength(undefined, "qwen3:8b")).toBeUndefined();
  });
});

describe("effectiveOllamaWindow", () => {
  it("is min(num_ctx or default, context_length)", () => {
    expect(effectiveOllamaWindow({ numCtx: 8192, contextLength: 40960 })).toBe(8192);
    expect(effectiveOllamaWindow({ numCtx: 65536, contextLength: 40960 })).toBe(40960);
    expect(effectiveOllamaWindow({ contextLength: 131072 })).toBe(OLLAMA_DEFAULT_NUM_CTX);
    expect(effectiveOllamaWindow({ contextLength: 2048 })).toBe(2048);
    expect(effectiveOllamaWindow({})).toBe(OLLAMA_DEFAULT_NUM_CTX);
  });

  it("prefers the loaded window, still capped by context_length", () => {
    expect(effectiveOllamaWindow({ numCtx: 8192, contextLength: 40960 }, 16384)).toBe(16384);
    expect(effectiveOllamaWindow({ contextLength: 40960 }, 262144)).toBe(40960);
  });
});

describe("ollamaApiBase / isOllamaEntry", () => {
  it("drops the OpenAI /v1 suffix", () => {
    expect(ollamaApiBase("http://localhost:11434/v1/")).toBe("http://localhost:11434");
    expect(ollamaApiBase("http://localhost:11434")).toBe("http://localhost:11434");
  });

  it("recognises a local Ollama by port or preset id, never Ollama Cloud", () => {
    expect(isOllamaEntry({ id: "my-box", baseUrl: "http://192.168.1.5:11434/v1" })).toBe(true);
    expect(isOllamaEntry({ id: "ollama", baseUrl: "http://gpu-box:8080" })).toBe(true);
    expect(isOllamaEntry({ id: "ollama-cloud", baseUrl: "https://ollama.com" })).toBe(false);
    expect(isOllamaEntry({ id: "lmstudio", baseUrl: "http://localhost:1234" })).toBe(false);
    expect(isOllamaEntry({ id: "ollama" })).toBe(false);
    expect(isOllamaEntry({ id: "ollama", baseUrl: "not a url" })).toBe(false);
  });
});

describe("readOllamaContextWindow", () => {
  it("posts the model name to /api/show on the root without /v1", async () => {
    const fetchImpl = fakeFetch({ "/api/show": () => jsonResponse(SHOW_BOTH), "/api/ps": () => jsonResponse({ models: [] }) });
    await expect(readOllamaContextWindow("http://localhost:11434/v1", "qwen3:8b", { fetchImpl })).resolves.toBe(8192);
    const show = fetchImpl.mock.calls.find(([url]) => url.endsWith("/api/show"));
    expect(show?.[0]).toBe("http://localhost:11434/api/show");
    const init = (show as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ model: "qwen3:8b" });
  });

  it("uses the default when only context_length is known", async () => {
    const fetchImpl = fakeFetch({ "/api/show": () => jsonResponse(SHOW_LENGTH_ONLY) });
    await expect(readOllamaContextWindow("http://localhost:11434", "llama3.1", { fetchImpl })).resolves.toBe(4096);
  });

  it("prefers the loaded window from /api/ps", async () => {
    const fetchImpl = fakeFetch({
      "/api/show": () => jsonResponse(SHOW_LENGTH_ONLY),
      "/api/ps": () => jsonResponse({ models: [{ name: "llama3.1:latest", context_length: 32768 }] }),
    });
    await expect(readOllamaContextWindow("http://localhost:11434", "llama3.1", { fetchImpl })).resolves.toBe(32768);
  });

  it("is null when the server is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(readOllamaContextWindow("http://localhost:11434", "llama3.1", { fetchImpl })).resolves.toBeNull();
  });

  it("is null on an error status, a non-JSON body or a body that is not Ollama's", async () => {
    await expect(readOllamaContextWindow("http://localhost:11434", "m", {
      fetchImpl: fakeFetch({ "/api/show": () => jsonResponse({ error: "model 'm' not found" }, 404) }),
    })).resolves.toBeNull();
    await expect(readOllamaContextWindow("http://localhost:11434", "m", {
      fetchImpl: fakeFetch({ "/api/show": () => new Response("<html>", { status: 200 }) }),
    })).resolves.toBeNull();
    await expect(readOllamaContextWindow("http://localhost:11434", "m", {
      fetchImpl: fakeFetch({ "/api/show": () => jsonResponse({ hello: "world" }) }),
    })).resolves.toBeNull();
  });

  it("is null when the probe times out", async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
      }),
    );
    await expect(readOllamaContextWindow("http://localhost:11434", "m", { fetchImpl, timeoutMs: 10 })).resolves.toBeNull();
  });
});
