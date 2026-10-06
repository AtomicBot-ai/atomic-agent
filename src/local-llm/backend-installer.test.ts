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

// `nvidia-smi` is stubbed so the Windows cases pick their asset from the
// hardware the test describes, not from whatever the host has. By default
// it is missing (Vulkan), as on the machines these tests run on.
const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

import {
  checkForBackendUpdate,
  downloadBackend,
  isBackendDownloaded,
  isInstalledVariantStale,
  resetLatestReleaseCache,
} from "./backend-installer.js";
import { resolveBackendDir, resolveServerBinPath } from "./backend-paths.js";
import { readBackendVersion, writeBackendVersion } from "./backend-version.js";
import {
  WINDOWS_BACKEND_ASSETS,
  resetWindowsBackendAssetCache,
  setConfiguredBackendVariant,
} from "./windows-backend-variant.js";

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
    resetWindowsBackendAssetCache();
    execSyncMock.mockReset();
    execSyncMock.mockImplementation(() => {
      throw new Error("nvidia-smi: not found");
    });
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    resetLatestReleaseCache();
    resetWindowsBackendAssetCache();
    setConfiguredBackendVariant("auto");
    rmSync(dir, { recursive: true, force: true });
  });

  it("downloads zip, extracts llama-server, writes backend-version.json", async () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
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
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
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
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
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
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
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
      // No patience: a dropped connection is retried for days by default,
      // and the staging cleanup is only exercised once the downloader has
      // given up. A zero no-progress window makes that the first failure.
      await expect(
        downloadBackend(dir, {
          maxRetries: 1,
          retryDelayMs: 1,
          giveUpAfterMs: 0,
        }),
      ).rejects.toThrow(/socket hang up/);

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
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
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
      await expect(downloadBackend(dir)).rejects.toThrow(
        /not found after extract/,
      );
      const binPath = resolveServerBinPath(dir, "llama-server");
      expect(readFileSync(binPath, "utf-8").includes("echo old")).toBe(true);
      expect(existsSync(`${join(dir, "backend")}.next`)).toBe(false);
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("replaces a stale staging dir left by a previous crash", async () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
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
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
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
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
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
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
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
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
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
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
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

  it("offers the CPU zip as an update when backendVariant 'cpu' is configured over a Vulkan install", async () => {
    // The CPU-fallback persistence loop-guard: after the fallback wrote
    // backendVariant "cpu", the staleness check must resolve the CPU
    // asset — not re-detect Vulkan and reinstall the build that just
    // failed on this machine.
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    setConfiguredBackendVariant("cpu");
    writeBackendVersion(dir, {
      tag: "turboquant-win",
      downloadedAt: "2026-06-02T00:00:00.000Z",
      asset: "llama-turboquant-windows-x64-vulkan.zip",
      releasedAt: "2026-06-01T00:00:00Z",
    });
    globalThis.fetch = vi.fn(async () =>
      releasesResponse([
        {
          tag: "turboquant-win",
          publishedAt: "2026-06-01T00:00:00Z",
          assetName: "llama-turboquant-windows-x64-cpu.zip",
        },
      ]),
    ) as typeof fetch;

    try {
      const check = await checkForBackendUpdate(dir);
      expect(check.updateAvailable).toBe(true);
    } finally {
      setConfiguredBackendVariant("auto");
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("treats a page-1 miss for this platform as 'no update', not an error", async () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
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
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
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

describe("Windows CUDA runtime guard (ATO-244)", () => {
  const TAG = "turboquant-6df272c";
  const PUBLISHED = "2026-09-20T00:00:00Z";
  let dir: string;
  let prevFetch: typeof fetch;
  let platformSpy: { mockRestore: () => void };
  let archSpy: { mockRestore: () => void };

  /** The reporter: RTX 3080 Ti (cc 8.6), driver 591.44 reporting CUDA 13.1. */
  function rtx3080TiOnDriver131(): void {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "nvidia-smi") {
        return Buffer.from(
          "| NVIDIA-SMI 591.44   Driver Version: 591.44   CUDA Version: 13.1 |",
        );
      }
      if (cmd.startsWith("nvidia-smi --query-gpu=compute_cap")) {
        return Buffer.from("8.6\n");
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
  }

  /** Lay out an installed backend dir holding `files`, described by `info`. */
  function installBackend(
    files: string[],
    info: Parameters<typeof writeBackendVersion>[1],
  ): void {
    const backendDir = resolveBackendDir(dir);
    mkdirSync(backendDir, { recursive: true });
    for (const f of ["llama-server.exe", ...files]) {
      writeFileSync(join(backendDir, f), "x");
    }
    writeBackendVersion(dir, info);
  }

  async function zipOf(files: string[]): Promise<Buffer> {
    const zip = new JSZip();
    for (const f of ["llama-server.exe", ...files]) {
      zip.file(f, Buffer.from(`fake ${f}`));
    }
    return zip.generateAsync({ type: "nodebuffer" });
  }

  /**
   * Serve one Windows release `tag` whose assets are `zips` (name →
   * archive). Records each asset URL fetched in `downloaded`.
   */
  function serveRelease(
    tag: string,
    publishedAt: string,
    zips: Record<string, Buffer>,
    downloaded: string[] = [],
  ): void {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/releases")) {
        return new Response(
          JSON.stringify([
            {
              tag_name: tag,
              published_at: publishedAt,
              assets: Object.keys(zips).map((name) => ({
                name,
                browser_download_url: `https://example.com/${name}`,
              })),
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const name = u.slice(u.lastIndexOf("/") + 1);
      const buf = zips[name];
      if (!buf) return new Response("not found", { status: 404 });
      downloaded.push(name);
      return new Response(buf, {
        status: 200,
        headers: { "content-length": String(buf.length) },
      });
    }) as typeof fetch;
  }

  const CUDA_124_FILES = [
    "ggml-cuda.dll",
    "cudart64_12.dll",
    "cublas64_12.dll",
    "cublasLt64_12.dll",
  ];
  const CUDA_133_FILES_AS_SHIPPED = ["ggml-cuda.dll"];
  const VULKAN_FILES = ["ggml-vulkan.dll"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-llm-cuda-guard-"));
    prevFetch = globalThis.fetch;
    resetLatestReleaseCache();
    resetWindowsBackendAssetCache();
    setConfiguredBackendVariant("auto");
    execSyncMock.mockReset();
    platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("x64");
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    resetLatestReleaseCache();
    resetWindowsBackendAssetCache();
    setConfiguredBackendVariant("auto");
    platformSpy.mockRestore();
    archSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("an installed cuda-13.3 without cudart is stale, even at the same tag", async () => {
    // The reporter's backend-version.json says cuda-13.3; detection now
    // wants cuda-12.4, so the existing auto-update start path re-pulls.
    rtx3080TiOnDriver131();
    installBackend(CUDA_133_FILES_AS_SHIPPED, {
      tag: TAG,
      downloadedAt: "2026-09-21T00:00:00.000Z",
      asset: WINDOWS_BACKEND_ASSETS.cuda133,
      releasedAt: PUBLISHED,
    });
    serveRelease(TAG, PUBLISHED, {
      [WINDOWS_BACKEND_ASSETS.cuda124]: await zipOf(CUDA_124_FILES),
      [WINDOWS_BACKEND_ASSETS.cuda133]: await zipOf(CUDA_133_FILES_AS_SHIPPED),
      [WINDOWS_BACKEND_ASSETS.vulkan]: await zipOf(VULKAN_FILES),
    });

    expect((await checkForBackendUpdate(dir)).updateAvailable).toBe(true);
  });

  it("the update then installs cuda-12.4 with its runtime", async () => {
    rtx3080TiOnDriver131();
    installBackend(CUDA_133_FILES_AS_SHIPPED, {
      tag: TAG,
      downloadedAt: "2026-09-21T00:00:00.000Z",
      asset: WINDOWS_BACKEND_ASSETS.cuda133,
      releasedAt: PUBLISHED,
    });
    const downloaded: string[] = [];
    serveRelease(
      TAG,
      PUBLISHED,
      {
        [WINDOWS_BACKEND_ASSETS.cuda124]: await zipOf(CUDA_124_FILES),
        [WINDOWS_BACKEND_ASSETS.cuda133]: await zipOf(CUDA_133_FILES_AS_SHIPPED),
        [WINDOWS_BACKEND_ASSETS.vulkan]: await zipOf(VULKAN_FILES),
      },
      downloaded,
    );

    await downloadBackend(dir);

    expect(downloaded).toEqual([WINDOWS_BACKEND_ASSETS.cuda124]);
    const installed = readBackendVersion(dir);
    expect(installed?.asset).toBe(WINDOWS_BACKEND_ASSETS.cuda124);
    expect(installed?.refusedCudaAsset).toBeUndefined();
    expect(existsSync(join(resolveBackendDir(dir), "cudart64_12.dll"))).toBe(
      true,
    );
    resetLatestReleaseCache();
    expect((await checkForBackendUpdate(dir)).updateAvailable).toBe(false);
  });

  it("an installed cuda-12.4 with cudart64_12.dll is not stale", async () => {
    rtx3080TiOnDriver131();
    installBackend(CUDA_124_FILES, {
      tag: TAG,
      downloadedAt: "2026-09-21T00:00:00.000Z",
      asset: WINDOWS_BACKEND_ASSETS.cuda124,
      releasedAt: PUBLISHED,
    });
    serveRelease(TAG, PUBLISHED, {
      [WINDOWS_BACKEND_ASSETS.cuda124]: await zipOf(CUDA_124_FILES),
    });

    expect((await checkForBackendUpdate(dir)).updateAvailable).toBe(false);
    expect(
      isInstalledVariantStale(
        dir,
        readBackendVersion(dir),
        WINDOWS_BACKEND_ASSETS.cuda124,
        TAG,
      ),
    ).toBe(false);
  });

  it("an installed cuda-12.4 that lost its cudart is stale at the same tag", async () => {
    // Damaged copy (antivirus quarantine, a partial manual copy): the
    // asset is the right one, but it would run on the CPU.
    rtx3080TiOnDriver131();
    installBackend(["ggml-cuda.dll", "cublas64_12.dll"], {
      tag: TAG,
      downloadedAt: "2026-09-21T00:00:00.000Z",
      asset: WINDOWS_BACKEND_ASSETS.cuda124,
      releasedAt: PUBLISHED,
    });
    serveRelease(TAG, PUBLISHED, {
      [WINDOWS_BACKEND_ASSETS.cuda124]: await zipOf(CUDA_124_FILES),
    });

    expect((await checkForBackendUpdate(dir)).updateAvailable).toBe(true);
  });

  it("an installed cuda-13.3 without cudart is stale even if detection wanted it", () => {
    installBackend(CUDA_133_FILES_AS_SHIPPED, {
      tag: TAG,
      downloadedAt: "2026-09-21T00:00:00.000Z",
      asset: WINDOWS_BACKEND_ASSETS.cuda133,
    });
    expect(
      isInstalledVariantStale(
        dir,
        readBackendVersion(dir),
        WINDOWS_BACKEND_ASSETS.cuda133,
        TAG,
      ),
    ).toBe(true);
  });

  it("leaves a pinned CUDA variant alone — the operator may have the toolkit", () => {
    setConfiguredBackendVariant("cuda-13.3");
    installBackend(CUDA_133_FILES_AS_SHIPPED, {
      tag: TAG,
      downloadedAt: "2026-09-21T00:00:00.000Z",
      asset: WINDOWS_BACKEND_ASSETS.cuda133,
    });
    expect(
      isInstalledVariantStale(
        dir,
        readBackendVersion(dir),
        WINDOWS_BACKEND_ASSETS.cuda133,
        TAG,
      ),
    ).toBe(false);
  });

  it("refuses a CUDA zip shipped without its runtime and installs Vulkan instead", async () => {
    rtx3080TiOnDriver131();
    // Hypothetical regression: the cuda-12.4 zip loses its runtime too.
    const downloaded: string[] = [];
    serveRelease(
      TAG,
      PUBLISHED,
      {
        [WINDOWS_BACKEND_ASSETS.cuda124]: await zipOf(["ggml-cuda.dll"]),
        [WINDOWS_BACKEND_ASSETS.vulkan]: await zipOf(VULKAN_FILES),
      },
      downloaded,
    );

    await downloadBackend(dir);

    expect(downloaded).toEqual([
      WINDOWS_BACKEND_ASSETS.cuda124,
      WINDOWS_BACKEND_ASSETS.vulkan,
    ]);
    const installed = readBackendVersion(dir);
    expect(installed?.asset).toBe(WINDOWS_BACKEND_ASSETS.vulkan);
    expect(installed?.refusedCudaAsset).toEqual({
      asset: WINDOWS_BACKEND_ASSETS.cuda124,
      tag: TAG,
    });
    const backendDir = resolveBackendDir(dir);
    expect(existsSync(join(backendDir, "ggml-vulkan.dll"))).toBe(true);
    expect(existsSync(join(backendDir, "ggml-cuda.dll"))).toBe(false);
    expect(existsSync(`${backendDir}.next`)).toBe(false);

    // Same release next start: the Vulkan stand-in holds, no re-download loop.
    resetLatestReleaseCache();
    expect((await checkForBackendUpdate(dir)).updateAvailable).toBe(false);

    // A newer release gets the CUDA zip tried afresh.
    resetLatestReleaseCache();
    serveRelease("turboquant-next", "2026-10-01T00:00:00Z", {
      [WINDOWS_BACKEND_ASSETS.cuda124]: await zipOf(CUDA_124_FILES),
      [WINDOWS_BACKEND_ASSETS.vulkan]: await zipOf(VULKAN_FILES),
    });
    expect((await checkForBackendUpdate(dir)).updateAvailable).toBe(true);
  });

  it("keeps the working install when a runtime-less CUDA zip has no Vulkan sibling", async () => {
    rtx3080TiOnDriver131();
    installBackend(VULKAN_FILES, {
      tag: "turboquant-old",
      downloadedAt: "2026-09-01T00:00:00.000Z",
      asset: WINDOWS_BACKEND_ASSETS.vulkan,
    });
    serveRelease(TAG, PUBLISHED, {
      [WINDOWS_BACKEND_ASSETS.cuda124]: await zipOf(["ggml-cuda.dll"]),
    });

    await expect(downloadBackend(dir)).rejects.toThrow(
      /ships without its CUDA runtime/,
    );
    expect(readBackendVersion(dir)?.tag).toBe("turboquant-old");
    expect(existsSync(`${resolveBackendDir(dir)}.next`)).toBe(false);
  });

  it("installs a pinned runtime-less CUDA zip as asked", async () => {
    setConfiguredBackendVariant("cuda-13.3");
    serveRelease(TAG, PUBLISHED, {
      [WINDOWS_BACKEND_ASSETS.cuda133]: await zipOf(CUDA_133_FILES_AS_SHIPPED),
      [WINDOWS_BACKEND_ASSETS.vulkan]: await zipOf(VULKAN_FILES),
    });

    await downloadBackend(dir);

    expect(readBackendVersion(dir)?.asset).toBe(WINDOWS_BACKEND_ASSETS.cuda133);
    expect(execSyncMock).not.toHaveBeenCalled();
  });
});
