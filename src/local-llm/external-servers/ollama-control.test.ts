import { describe, expect, it } from "vitest";

import {
  OllamaError,
  blobPathFromModelfile,
  deleteOllamaModel,
  ollamaModelBlobPath,
  pullOllamaModel,
  readPullLine,
  unloadOllamaModel,
  type OllamaPullProgress,
} from "./ollama-control.js";

interface Seen {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(answer: (s: Seen) => Response, seen: Seen[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const s = { url: String(url), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : null };
    seen.push(s);
    return answer(s);
  }) as typeof fetch;
}

describe("Ollama control (ATO-2490)", () => {
  it("unload is /api/generate with keep_alive 0", async () => {
    const seen: Seen[] = [];
    await unloadOllamaModel("qwen3:8b", { fetch: fakeFetch(() => new Response("{}"), seen) });
    expect(seen).toEqual([{ url: "http://127.0.0.1:11434/api/generate", method: "POST", body: { model: "qwen3:8b", keep_alive: 0, stream: false } }]);
  });

  it("delete is DELETE /api/delete; a missing model says so in words", async () => {
    const seen: Seen[] = [];
    await deleteOllamaModel("llama3.2:3b", { fetch: fakeFetch(() => new Response("{}"), seen) });
    expect(seen[0]).toMatchObject({ url: "http://127.0.0.1:11434/api/delete", method: "DELETE", body: { model: "llama3.2:3b" } });
    const missing = deleteOllamaModel("nope", { fetch: fakeFetch(() => new Response('{"error":"model not found"}', { status: 404 })) });
    await expect(missing).rejects.toThrow("Ollama has no model called nope.");
  });

  it("a name that could be a flag never reaches Ollama", async () => {
    const seen: Seen[] = [];
    await expect(unloadOllamaModel("--all", { fetch: fakeFetch(() => new Response("{}"), seen) })).rejects.toBeInstanceOf(OllamaError);
    expect(seen).toEqual([]);
  });

  it("not running reads as a sentence, the socket error as detail", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const err = await unloadOllamaModel("qwen3:8b", { fetch: down }).catch((e: OllamaError) => e);
    expect(err).toBeInstanceOf(OllamaError);
    expect((err as OllamaError).message).toBe("Ollama is not answering. Start it and try again.");
    expect((err as OllamaError).detail).toBe("fetch failed");
  });

  it("pull reads NDJSON progress across chunk breaks and ends on success", async () => {
    const lines = [
      '{"status":"pulling manifest"}\n{"status":"pulling abc","total":100,"comp',
      'leted":40}\n{"status":"success"}\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l)); c.close(); },
    });
    const got: OllamaPullProgress[] = [];
    await pullOllamaModel("qwen3:8b", (p) => got.push(p), { fetch: fakeFetch(() => new Response(body)) });
    expect(got).toEqual([
      { status: "pulling manifest", completed: null, total: null },
      { status: "pulling abc", completed: 40, total: 100 },
      { status: "success", completed: null, total: null },
    ]);
  });

  it("pull without success, or with an error line, fails", async () => {
    await expect(pullOllamaModel("x", () => {}, { fetch: fakeFetch(() => new Response('{"status":"pulling manifest"}\n')) }))
      .rejects.toThrow("stopped before it finished");
    expect(() => readPullLine('{"error":"pull model manifest: file does not exist"}')).toThrow(OllamaError);
    expect(readPullLine("not json")).toBeNull();
  });

  it("the blob path comes from the modelfile's FROM line", async () => {
    expect(blobPathFromModelfile("# Modelfile\nFROM /Users/me/.ollama/models/blobs/sha256-abc\nTEMPLATE x")).toBe("/Users/me/.ollama/models/blobs/sha256-abc");
    expect(blobPathFromModelfile("FROM qwen3:8b\n")).toBeNull();
    expect(blobPathFromModelfile('FROM "C:\\Users\\me\\.ollama\\models\\blobs\\sha256-abc"')).toBe("C:\\Users\\me\\.ollama\\models\\blobs\\sha256-abc");
    const path = await ollamaModelBlobPath("qwen3:8b", {
      fetch: fakeFetch(() => new Response(JSON.stringify({ modelfile: "FROM /b/sha256-1\n" }))),
    });
    expect(path).toBe("/b/sha256-1");
  });
});
