import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadBackend, isBackendDownloaded } from "./backend-installer.js";
import { resolveServerBinPath } from "./backend-paths.js";
import { readBackendVersion } from "./backend-version.js";

describe("backend-installer", () => {
  let dir: string;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-llm-be-"));
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it("downloads zip, extracts llama-server, writes backend-version.json", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    const zip = new JSZip();
    zip.file("release-root/llama-server", Buffer.from("#!/bin/sh\necho ok\n"));
    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: "turboquant-test-1",
            assets: [
              {
                name: "llama-turboquant-macos-arm64.zip",
                browser_download_url: "https://example.com/asset.zip",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("asset.zip")) {
        return new Response(zipBuf, {
          status: 200,
          headers: { "content-length": String(zipBuf.length) },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      await downloadBackend(dir);

      const binPath = resolveServerBinPath(dir, "llama-server");
      expect(existsSync(binPath)).toBe(true);
      expect(readFileSync(binPath, "utf-8").includes("echo ok")).toBe(true);
      expect(isBackendDownloaded(dir)).toBe(true);
      expect(readBackendVersion(dir)?.tag).toBe("turboquant-test-1");
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("flattens nested build/bin/llama-server layout into backend root", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    const zip = new JSZip();
    zip.file("build/bin/llama-server", Buffer.from("#!/bin/sh\necho nested\n"));
    zip.file("build/bin/llama-cli", Buffer.from("#!/bin/sh\necho cli\n"));
    zip.file("build/bin/libmtmd.dylib", Buffer.from("fakelib"));
    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: "turboquant-nested-1",
            assets: [
              {
                name: "llama-turboquant-macos-arm64.zip",
                browser_download_url: "https://example.com/nested.zip",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("nested.zip")) {
        return new Response(zipBuf, {
          status: 200,
          headers: { "content-length": String(zipBuf.length) },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      await downloadBackend(dir);

      const binPath = resolveServerBinPath(dir, "llama-server");
      expect(existsSync(binPath)).toBe(true);
      expect(readFileSync(binPath, "utf-8").includes("echo nested")).toBe(true);
      // Sibling binaries and shared libs from the same bin/ directory
      // should also have been promoted to the backend root.
      expect(existsSync(join(dir, "backend", "llama-cli"))).toBe(true);
      expect(existsSync(join(dir, "backend", "libmtmd.dylib"))).toBe(true);
      // Wrapper dirs must be cleaned up.
      expect(existsSync(join(dir, "backend", "build"))).toBe(false);
      expect(isBackendDownloaded(dir)).toBe(true);
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("handles flat archives where llama-server is at the zip root", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    const zip = new JSZip();
    zip.file("llama-server", Buffer.from("#!/bin/sh\necho flat\n"));
    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: "turboquant-flat-1",
            assets: [
              {
                name: "llama-turboquant-macos-arm64.zip",
                browser_download_url: "https://example.com/flat.zip",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("flat.zip")) {
        return new Response(zipBuf, {
          status: 200,
          headers: { "content-length": String(zipBuf.length) },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      await downloadBackend(dir);
      const binPath = resolveServerBinPath(dir, "llama-server");
      expect(existsSync(binPath)).toBe(true);
      expect(readFileSync(binPath, "utf-8").includes("echo flat")).toBe(true);
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("isBackendDownloaded is false on unsupported platform", () => {
    const orig = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      expect(isBackendDownloaded(dir)).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: orig, configurable: true });
    }
  });
});
