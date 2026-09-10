import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  downloadFile,
  resolvePartialMetaPath,
  resolvePartialPath,
} from "./download-file.js";
import { listHuggingFaceGgufFiles } from "./huggingface-api.js";
import {
  DEFAULT_HF_ENDPOINT,
  huggingFaceEndpointHost,
  isHuggingFaceUrl,
  normalizeHuggingFaceEndpoint,
  resolveHuggingFaceEndpoint,
  rewriteHuggingFaceUrl,
  setDefaultHuggingFaceEndpoint,
} from "./huggingface-endpoint.js";

const CANONICAL =
  "https://huggingface.co/unsloth/gemma-4-E4B-it-qat-GGUF/resolve/main/mmproj-BF16.gguf";

describe("huggingface-endpoint", () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.HF_ENDPOINT;
    delete process.env.HF_ENDPOINT;
    setDefaultHuggingFaceEndpoint(DEFAULT_HF_ENDPOINT);
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.HF_ENDPOINT;
    else process.env.HF_ENDPOINT = prevEnv;
    setDefaultHuggingFaceEndpoint(DEFAULT_HF_ENDPOINT);
  });

  it("normalizes to an origin, dropping trailing slashes and rejecting junk", () => {
    expect(normalizeHuggingFaceEndpoint("https://hf-mirror.com/")).toBe(
      "https://hf-mirror.com",
    );
    expect(normalizeHuggingFaceEndpoint("  http://localhost:8080//  ")).toBe(
      "http://localhost:8080",
    );
    expect(normalizeHuggingFaceEndpoint("https://proxy.example/hf/")).toBe(
      "https://proxy.example/hf",
    );
    expect(normalizeHuggingFaceEndpoint("hf-mirror.com")).toBeNull();
    expect(normalizeHuggingFaceEndpoint("ftp://x")).toBeNull();
    expect(normalizeHuggingFaceEndpoint("")).toBeNull();
  });

  it("uses the configured endpoint, and lets HF_ENDPOINT win over it", () => {
    expect(resolveHuggingFaceEndpoint()).toBe(DEFAULT_HF_ENDPOINT);
    setDefaultHuggingFaceEndpoint("https://hf-mirror.com/");
    expect(resolveHuggingFaceEndpoint()).toBe("https://hf-mirror.com");
    process.env.HF_ENDPOINT = "https://other.example";
    expect(resolveHuggingFaceEndpoint()).toBe("https://other.example");
    expect(huggingFaceEndpointHost()).toBe("other.example");
    // An unusable env value falls back to the configured one.
    process.env.HF_ENDPOINT = "not a url";
    expect(resolveHuggingFaceEndpoint()).toBe("https://hf-mirror.com");
  });

  it("rewrites canonical URLs only, and only when a mirror is active", () => {
    expect(rewriteHuggingFaceUrl(CANONICAL)).toBe(CANONICAL);
    setDefaultHuggingFaceEndpoint("https://hf-mirror.com");
    expect(rewriteHuggingFaceUrl(CANONICAL)).toBe(
      "https://hf-mirror.com/unsloth/gemma-4-E4B-it-qat-GGUF/resolve/main/mmproj-BF16.gguf",
    );
    expect(rewriteHuggingFaceUrl("https://hf.co/o/r/resolve/main/f.gguf")).toBe(
      "https://hf-mirror.com/o/r/resolve/main/f.gguf",
    );
    const github =
      "https://github.com/ggml-org/llama.cpp/releases/download/b1/x.zip";
    expect(rewriteHuggingFaceUrl(github)).toBe(github);
    expect(isHuggingFaceUrl(CANONICAL)).toBe(true);
    expect(
      isHuggingFaceUrl("https://hf-mirror.com/o/r/resolve/main/f.gguf"),
    ).toBe(true);
    expect(isHuggingFaceUrl(github)).toBe(false);
  });

  describe("on the wire", () => {
    let dir: string;
    let prevFetch: typeof fetch;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "hf-endpoint-"));
      prevFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = prevFetch;
      rmSync(dir, { recursive: true, force: true });
    });

    it("lists a repo's files from the mirror's API", async () => {
      process.env.HF_ENDPOINT = "https://hf-mirror.com";
      const urls: string[] = [];
      globalThis.fetch = vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify([{ path: "a.gguf", size: 5, lfs: { size: 500 } }]),
          {
            status: 200,
          },
        );
      }) as typeof fetch;

      const files = await listHuggingFaceGgufFiles("owner/repo");
      expect(urls).toEqual([
        "https://hf-mirror.com/api/models/owner/repo/tree/main?recursive=true",
      ]);
      expect(files).toEqual([{ path: "a.gguf", sizeBytes: 500 }]);
    });

    it("downloads from the mirror while the sidecar keeps the canonical URL", async () => {
      process.env.HF_ENDPOINT = "https://hf-mirror.com";
      const dest = join(dir, "mmproj.gguf");
      const urls: string[] = [];
      // First run: one chunk, then the connection dies; the partial stays.
      globalThis.fetch = vi.fn(async (url: unknown) => {
        urls.push(String(url));
        let pulls = 0;
        const body = new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(Buffer.from("ab"));
            else controller.error(new Error("read ECONNRESET"));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-length": "4", etag: '"v1"' },
        });
      }) as typeof fetch;
      await expect(
        // `giveUpAfterMs: 0` is how a caller says "do not wait this
        // outage out": since #356 a transport failure retries for as
        // long as the no-progress window allows, not `maxRetries` times.
        downloadFile(CANONICAL, dest, {
          retryDelayMs: 1,
          stallTimeoutMs: 0,
          maxRetries: 0,
          giveUpAfterMs: 0,
        }),
      ).rejects.toThrow(/ECONNRESET/);
      expect(urls[0]).toBe(
        "https://hf-mirror.com/unsloth/gemma-4-E4B-it-qat-GGUF/resolve/main/mmproj-BF16.gguf",
      );
      const sidecar = JSON.parse(
        readFileSync(resolvePartialMetaPath(dest), "utf-8"),
      );
      expect(sidecar.source).toBe(CANONICAL);
      expect(readFileSync(resolvePartialPath(dest), "utf-8")).toBe("ab");

      // Second run without the mirror: the partial is still recognised
      // and the remainder comes from huggingface.co.
      delete process.env.HF_ENDPOINT;
      const ranges: Array<string | null> = [];
      globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        urls.push(String(url));
        ranges.push(new Headers(init?.headers).get("range"));
        return new Response(Buffer.from("cd"), {
          status: 206,
          headers: { "content-range": "bytes 2-3/4", etag: '"v1"' },
        });
      }) as typeof fetch;
      await downloadFile(CANONICAL, dest, {
        retryDelayMs: 1,
        stallTimeoutMs: 0,
      });
      expect(urls[1]).toBe(CANONICAL);
      expect(ranges).toEqual(["bytes=2-"]);
      expect(readFileSync(dest, "utf-8")).toBe("abcd");
    });
  });
});
