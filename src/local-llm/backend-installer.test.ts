import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkForBackendUpdate,
  downloadBackend,
  isBackendDownloaded,
  resetLatestReleaseCache,
} from "./backend-installer.js";
import { resolveServerBinPath } from "./backend-paths.js";
import { readBackendVersion, writeBackendVersion } from "./backend-version.js";

/** Minimal GitHub releases-list payload for the macOS arm64 asset. */
function releasesResponse(
  releases: Array<{
    tag: string;
    url?: string;
    publishedAt?: string | null;
    assetName?: string;
  }>,
): Response {
  return new Response(
    JSON.stringify(
      releases.map((r) => ({
        tag_name: r.tag,
        published_at: r.publishedAt === undefined ? null : r.publishedAt,
        assets: [
          {
            name: r.assetName ?? "llama-turboquant-macos-arm64.zip",
            browser_download_url: r.url ?? "https://example.com/asset.zip",
          },
        ],
      })),
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("backend-installer", () => {
  let dir: string;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-llm-be-"));
    prevFetch = globalThis.fetch;
    resetLatestReleaseCache();
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    resetLatestReleaseCache();
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
      if (u.includes("/releases")) {
        return new Response(
          JSON.stringify([
            {
              tag_name: "turboquant-windows-9",
              assets: [
                {
                  name: "llama-turboquant-windows-x64-vulkan.zip",
                  browser_download_url: "https://example.com/win.zip",
                },
              ],
            },
            {
              tag_name: "turboquant-test-1",
              assets: [
                {
                  name: "llama-turboquant-macos-arm64.zip",
                  browser_download_url: "https://example.com/asset.zip",
                },
              ],
            },
          ]),
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
      if (u.includes("/releases")) {
        return new Response(
          JSON.stringify([
            {
              tag_name: "turboquant-nested-1",
              assets: [
                {
                  name: "llama-turboquant-macos-arm64.zip",
                  browser_download_url: "https://example.com/nested.zip",
                },
              ],
            },
          ]),
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
      if (u.includes("/releases")) {
        return new Response(
          JSON.stringify([
            {
              tag_name: "turboquant-flat-1",
              assets: [
                {
                  name: "llama-turboquant-macos-arm64.zip",
                  browser_download_url: "https://example.com/flat.zip",
                },
              ],
            },
          ]),
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

  it("keeps the working install when the download fails mid-flight", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    // Pre-existing, working install.
    const backendDir = join(dir, "backend");
    mkdirSync(backendDir, { recursive: true });
    writeFileSync(join(backendDir, "llama-server"), "#!/bin/sh\necho old\n", {
      mode: 0o755,
    });
    writeBackendVersion(dir, {
      tag: "turboquant-old",
      downloadedAt: "2026-01-01T00:00:00.000Z",
      asset: "llama-turboquant-macos-arm64.zip",
    });

    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/releases")) {
        return releasesResponse([
          { tag: "turboquant-new", publishedAt: "2026-02-01T00:00:00Z" },
        ]);
      }
      // Asset download dies part-way through, as a dropped connection does.
      throw new Error("socket hang up");
    }) as typeof fetch;

    try {
      await expect(downloadBackend(dir)).rejects.toThrow(/socket hang up/);

      const binPath = resolveServerBinPath(dir, "llama-server");
      expect(existsSync(binPath)).toBe(true);
      expect(readFileSync(binPath, "utf-8").includes("echo old")).toBe(true);
      expect(isBackendDownloaded(dir)).toBe(true);
      // The version record must still describe the install that is live.
      expect(readBackendVersion(dir)?.tag).toBe("turboquant-old");
      // No staging leftovers.
      expect(existsSync(`${join(dir, "backend")}.next`)).toBe(false);
      expect(existsSync(`${join(dir, "backend")}.old`)).toBe(false);
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("keeps the working install when the archive has no server binary", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    const backendDir = join(dir, "backend");
    mkdirSync(backendDir, { recursive: true });
    writeFileSync(join(backendDir, "llama-server"), "#!/bin/sh\necho old\n", {
      mode: 0o755,
    });

    // Well-formed zip, but it ships the wrong payload — the corrupt /
    // mis-built release case.
    const zip = new JSZip();
    zip.file("release-root/README.md", Buffer.from("no binary here"));
    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/releases")) {
        return releasesResponse([
          { tag: "turboquant-broken", publishedAt: "2026-02-01T00:00:00Z" },
        ]);
      }
      return new Response(zipBuf, {
        status: 200,
        headers: { "content-length": String(zipBuf.length) },
      });
    }) as typeof fetch;

    try {
      await expect(downloadBackend(dir)).rejects.toThrow(/not found after extract/);
      const binPath = resolveServerBinPath(dir, "llama-server");
      expect(readFileSync(binPath, "utf-8").includes("echo old")).toBe(true);
      expect(existsSync(`${join(dir, "backend")}.next`)).toBe(false);
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("replaces a stale staging dir left by a previous crash", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    // Crash leftovers: a half-extracted `.next` carrying a foreign
    // wrapper dir that would poison the flatten step, and a `.old`.
    const stagingDir = join(dir, "backend.next");
    mkdirSync(join(stagingDir, "build", "bin"), { recursive: true });
    writeFileSync(join(stagingDir, "build", "bin", "llama-server"), "stale");
    mkdirSync(join(dir, "backend.old"), { recursive: true });

    const zip = new JSZip();
    zip.file("llama-server", Buffer.from("#!/bin/sh\necho fresh\n"));
    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/releases")) {
        return releasesResponse([
          { tag: "turboquant-fresh", publishedAt: "2026-02-01T00:00:00Z" },
        ]);
      }
      return new Response(zipBuf, {
        status: 200,
        headers: { "content-length": String(zipBuf.length) },
      });
    }) as typeof fetch;

    try {
      await downloadBackend(dir);
      const binPath = resolveServerBinPath(dir, "llama-server");
      expect(readFileSync(binPath, "utf-8").includes("echo fresh")).toBe(true);
      expect(existsSync(join(dir, "backend", "build"))).toBe(false);
      expect(existsSync(stagingDir)).toBe(false);
      expect(existsSync(join(dir, "backend.old"))).toBe(false);
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("records the release timestamp so later checks can order against it", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    const zip = new JSZip();
    zip.file("llama-server", Buffer.from("#!/bin/sh\necho ok\n"));
    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/releases")) {
        return releasesResponse([
          { tag: "turboquant-dated", publishedAt: "2026-02-03T04:05:06Z" },
        ]);
      }
      return new Response(zipBuf, {
        status: 200,
        headers: { "content-length": String(zipBuf.length) },
      });
    }) as typeof fetch;

    try {
      await downloadBackend(dir);
      expect(readBackendVersion(dir)?.releasedAt).toBe("2026-02-03T04:05:06Z");
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("does not downgrade when a re-published older tag heads the list", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    writeBackendVersion(dir, {
      tag: "turboquant-june",
      downloadedAt: "2026-06-02T00:00:00.000Z",
      asset: "llama-turboquant-macos-arm64.zip",
      releasedAt: "2026-06-01T00:00:00Z",
    });
    // A maintainer re-published the old January release, so GitHub's
    // created_at ordering puts it first. Its own timestamp is still older.
    globalThis.fetch = vi.fn(async () =>
      releasesResponse([
        { tag: "turboquant-january", publishedAt: "2026-01-01T00:00:00Z" },
        { tag: "turboquant-june", publishedAt: "2026-06-01T00:00:00Z" },
      ]),
    ) as typeof fetch;

    try {
      const check = await checkForBackendUpdate(dir);
      expect(check.updateAvailable).toBe(false);
      expect(check.latestTag).toBe("turboquant-june");
      expect(check.currentTag).toBe("turboquant-june");
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("does not downgrade when the newest available release predates the install", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    writeBackendVersion(dir, {
      tag: "turboquant-june",
      downloadedAt: "2026-06-02T00:00:00.000Z",
      asset: "llama-turboquant-macos-arm64.zip",
      releasedAt: "2026-06-01T00:00:00Z",
    });
    // The June release was deleted from the repo; the newest one still
    // listed is older than what this machine already runs.
    globalThis.fetch = vi.fn(async () =>
      releasesResponse([
        { tag: "turboquant-may", publishedAt: "2026-05-01T00:00:00Z" },
        { tag: "turboquant-april", publishedAt: "2026-04-01T00:00:00Z" },
      ]),
    ) as typeof fetch;

    try {
      const check = await checkForBackendUpdate(dir);
      expect(check.updateAvailable).toBe(false);
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("still updates when the resolved release is genuinely newer", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    writeBackendVersion(dir, {
      tag: "turboquant-june",
      downloadedAt: "2026-06-02T00:00:00.000Z",
      asset: "llama-turboquant-macos-arm64.zip",
      releasedAt: "2026-06-01T00:00:00Z",
    });
    globalThis.fetch = vi.fn(async () =>
      releasesResponse([
        { tag: "turboquant-july", publishedAt: "2026-07-01T00:00:00Z" },
        { tag: "turboquant-june", publishedAt: "2026-06-01T00:00:00Z" },
      ]),
    ) as typeof fetch;

    try {
      const check = await checkForBackendUpdate(dir);
      expect(check.updateAvailable).toBe(true);
      expect(check.latestTag).toBe("turboquant-july");
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("updates on a variant change even though the tag is unchanged", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    // Installed the Vulkan build; the machine now warrants CUDA. Same
    // tag, same timestamp — recency must not veto the variant re-pull.
    writeBackendVersion(dir, {
      tag: "turboquant-win",
      downloadedAt: "2026-06-02T00:00:00.000Z",
      asset: "llama-turboquant-windows-x64-cuda-13.3.zip",
      releasedAt: "2026-06-01T00:00:00Z",
    });
    globalThis.fetch = vi.fn(async () =>
      releasesResponse([
        {
          tag: "turboquant-win",
          publishedAt: "2026-06-01T00:00:00Z",
          assetName: "llama-turboquant-windows-x64-vulkan.zip",
        },
      ]),
    ) as typeof fetch;

    try {
      const check = await checkForBackendUpdate(dir);
      expect(check.updateAvailable).toBe(true);
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("treats a page-1 miss for this platform as 'no update', not an error", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    writeBackendVersion(dir, {
      tag: "turboquant-installed",
      downloadedAt: "2026-06-02T00:00:00.000Z",
      asset: "llama-turboquant-macos-arm64.zip",
    });
    // Page 1 is all Windows releases — the macOS asset fell off the end.
    globalThis.fetch = vi.fn(async () =>
      releasesResponse([
        {
          tag: "turboquant-windows-9",
          publishedAt: "2026-07-01T00:00:00Z",
          assetName: "llama-turboquant-windows-x64-vulkan.zip",
        },
      ]),
    ) as typeof fetch;

    try {
      const check = await checkForBackendUpdate(dir);
      expect(check.updateAvailable).toBe(false);
      expect(check.latestTag).toBeNull();
      expect(check.currentTag).toBe("turboquant-installed");
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("bounds the releases request with a timeout signal", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return releasesResponse([
        { tag: "turboquant-x", publishedAt: "2026-07-01T00:00:00Z" },
      ]);
    }) as typeof fetch;

    try {
      await checkForBackendUpdate(dir);
      // A black-holed connection must not hang the start path until the
      // OS TCP timeout, so the request has to carry an abort signal.
      expect(seenSignal).toBeInstanceOf(AbortSignal);
      expect(seenSignal?.aborted).toBe(false);
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("isBackendDownloaded is false on unsupported platform (darwin x64)", () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    try {
      expect(isBackendDownloaded(dir)).toBe(false);
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });
});
