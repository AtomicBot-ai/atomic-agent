import { describe, expect, it } from "vitest";

import {
  describeDetectedServer,
  detectLocalServers,
  LOCAL_SERVER_TARGETS,
  readLoadedIds,
  readModelIds,
} from "./detect-local-servers.js";

/** A fake `fetch` that answers the listed URLs and refuses every other one. */
function fakeFetch(routes: Record<string, unknown>): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (!(url in routes)) throw new TypeError("fetch failed: ECONNREFUSED");
    const body = routes[url];
    if (typeof body === "number") return new Response("nope", { status: body });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe("detectLocalServers", () => {
  it("finds nothing when every port refuses", async () => {
    const { fetch, calls } = fakeFetch({});
    expect(await detectLocalServers({ fetch })).toEqual([]);
    // One probe per default port: llama.cpp 9931, Ollama 11434, LM Studio 1234.
    expect(calls).toEqual([
      "http://127.0.0.1:9931/v1/models",
      "http://127.0.0.1:11434/api/tags",
      "http://127.0.0.1:1234/v1/models",
    ]);
  });

  it("finds Ollama with its models and the ones loaded in memory", async () => {
    const { fetch } = fakeFetch({
      "http://127.0.0.1:11434/api/tags": {
        models: [{ name: "qwen3:8b", model: "qwen3:8b" }, { name: "gemma3:4b" }],
      },
      "http://127.0.0.1:11434/api/ps": { models: [{ name: "qwen3:8b", size: 1 }] },
    });
    const found = await detectLocalServers({ fetch });
    expect(found).toEqual([
      {
        kind: "ollama",
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434",
        presetId: "ollama",
        models: ["qwen3:8b", "gemma3:4b"],
        loaded: ["qwen3:8b"],
      },
    ]);
    expect(describeDetectedServer(found[0]!)).toBe("Ollama (2 models, 1 loaded)");
  });

  it("finds LM Studio and the Llama app, in the recommended order", async () => {
    const { fetch } = fakeFetch({
      "http://127.0.0.1:1234/v1/models": { object: "list", data: [{ id: "qwen/qwen3-8b" }] },
      "http://127.0.0.1:9931/v1/models": { object: "list", data: [{ id: "gemma-3-4b-it" }] },
    });
    const found = await detectLocalServers({ fetch });
    expect(found.map((s) => s.kind)).toEqual(["llama-app", "lmstudio"]);
    expect(found[0]!.presetId).toBeNull();
    expect(found[1]!.presetId).toBe("lmstudio");
    expect(found[1]!.models).toEqual(["qwen/qwen3-8b"]);
    expect(describeDetectedServer(found[0]!)).toBe("Llama app (llama.cpp) (1 model)");
  });

  it("reads which LM Studio models are loaded from its REST model list", async () => {
    const { fetch } = fakeFetch({
      "http://127.0.0.1:1234/v1/models": {
        object: "list",
        data: [{ id: "qwen/qwen3-8b" }, { id: "google/gemma-3-4b" }],
      },
      "http://127.0.0.1:1234/api/v0/models": {
        object: "list",
        data: [
          { id: "qwen/qwen3-8b", type: "llm", state: "loaded" },
          { id: "google/gemma-3-4b", type: "llm", state: "not-loaded" },
        ],
      },
    });
    const found = await detectLocalServers({ fetch });
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("lmstudio");
    expect(found[0]!.loaded).toEqual(["qwen/qwen3-8b"]);
    expect(describeDetectedServer(found[0]!)).toBe("LM Studio (2 models, 1 loaded)");
  });

  it("keeps LM Studio with nothing loaded when its REST list is missing", async () => {
    const { fetch } = fakeFetch({
      "http://127.0.0.1:1234/v1/models": { object: "list", data: [{ id: "qwen/qwen3-8b" }] },
      "http://127.0.0.1:1234/api/v0/models": 404,
    });
    const found = await detectLocalServers({ fetch });
    expect(found[0]!.loaded).toEqual([]);
  });

  it("keeps Ollama when only its loaded-models call fails", async () => {
    const { fetch } = fakeFetch({
      "http://127.0.0.1:11434/api/tags": { models: [] },
      "http://127.0.0.1:11434/api/ps": 500,
    });
    const found = await detectLocalServers({ fetch });
    expect(found).toHaveLength(1);
    expect(found[0]!.models).toEqual([]);
    expect(found[0]!.loaded).toEqual([]);
  });

  it("skips a port held by something that is not a model server", async () => {
    const { fetch } = fakeFetch({
      // An HTML page or an unrelated JSON API on the same port.
      "http://127.0.0.1:1234/v1/models": { hello: "world" },
      "http://127.0.0.1:11434/api/tags": 404,
    });
    expect(await detectLocalServers({ fetch })).toEqual([]);
  });

  it("gives up on a server that does not answer within the timeout", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await detectLocalServers({ fetch: hanging, timeoutMs: 30 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("probes only the targets it is given", async () => {
    const { fetch, calls } = fakeFetch({});
    await detectLocalServers({ fetch, targets: [LOCAL_SERVER_TARGETS[1]!] });
    expect(calls).toEqual(["http://127.0.0.1:11434/api/tags"]);
  });
});

describe("readLoadedIds", () => {
  it("keeps only LM Studio models whose state is loaded", () => {
    expect(
      readLoadedIds("lmstudio", {
        data: [{ id: "a", state: "loaded" }, { id: "b", state: "not-loaded" }, { id: "c" }],
      }),
    ).toEqual(["a"]);
    expect(readLoadedIds("lmstudio", { models: [] })).toEqual([]);
  });

  it("reads Ollama's /api/ps list as it is", () => {
    expect(readLoadedIds("ollama", { models: [{ name: "qwen3:8b" }] })).toEqual(["qwen3:8b"]);
  });
});

describe("readModelIds", () => {
  it("reads Ollama names and falls back to the model field", () => {
    expect(readModelIds("ollama", { models: [{ model: "llama3.2" }] })).toEqual(["llama3.2"]);
  });

  it("rejects bodies of the wrong shape", () => {
    expect(readModelIds("ollama", { data: [{ id: "x" }] })).toBeNull();
    expect(readModelIds("lmstudio", { models: [{ name: "x" }] })).toBeNull();
    expect(readModelIds("llama-app", null)).toBeNull();
  });
});
