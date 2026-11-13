import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `nvidia-smi` is stubbed so each case describes its own hardware.
const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

import {
  checkForBackendUpdate,
  downloadBackend,
  isBackendDownloaded,
  resetLatestReleaseCache,
} from "./backend-installer.js";
import { resolveBackendDir, resolveServerBinPath } from "../backend-paths.js";
import { readBackendVersion } from "./backend-version.js";
import {
  LINUX_X64_BACKEND_ASSETS,
  resetLinuxX64BackendAssetCache,
} from "./linux-x64-backend-variant.js";
import { NIGHTLY_BACKEND_REPO, STABLE_BACKEND_REPO } from "./platform-assets.js";
import {
  resetWindowsBackendAssetCache,
  setConfiguredBackendVariant,
} from "./windows-backend-variant.js";

const MAC_ASSET = "llama-turboquant-macos-arm64.zip";

interface FakeRelease {
  tag: string;
  publishedAt: string;
  prerelease?: boolean;
  assets: Record<string, Buffer>;
}

/** Serve `releases` from any repo; records the list URLs and the downloaded asset names. */
function serve(releases: FakeRelease[]): { listUrls: string[]; downloaded: string[] } {
  const listUrls: string[] = [];
  const downloaded: string[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("api.github.com")) {
      listUrls.push(u);
      return new Response(
        JSON.stringify(
          releases.map((r) => ({
            tag_name: r.tag,
            prerelease: r.prerelease ?? false,
            published_at: r.publishedAt,
            assets: Object.keys(r.assets).map((name) => ({
              name,
              browser_download_url: `https://example.com/${r.tag}/${name}`,
            })),
          })),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const [, tag, name] = u.match(/example\.com\/([^/]+)\/(.+)$/) ?? [];
    const buf = releases.find((r) => r.tag === tag)?.assets[name ?? ""];
    if (!buf) return new Response("not found", { status: 404 });
    downloaded.push(name!);
    return new Response(buf, {
      status: 200,
      headers: { "content-length": String(buf.length) },
    });
  }) as typeof fetch;
  return { listUrls, downloaded };
}

async function serverZip(text = "#!/bin/sh\necho ok\n"): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("build/bin/llama-server", Buffer.from(text));
  return zip.generateAsync({ type: "nodebuffer" });
}

/** nvidia-smi answering the Linux query with one GPU. */
function nvidiaSmi(line: string): void {
  execSyncMock.mockImplementation((cmd: string) => {
    if (String(cmd).includes("--query-gpu=driver_version")) return Buffer.from(`${line}\n`);
    throw new Error("unexpected nvidia-smi call");
  });
}

describe("direct engine downloads from the stable turboquant repo (ATO-619)", () => {
  let dir: string;
  let prevFetch: typeof fetch;
  const spies: Array<{ mockRestore: () => void }> = [];

  function onHost(platform: NodeJS.Platform, arch: string): void {
    spies.push(vi.spyOn(process, "platform", "get").mockReturnValue(platform));
    spies.push(vi.spyOn(process, "arch", "get").mockReturnValue(arch as NodeJS.Architecture));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-llm-stable-"));
    prevFetch = globalThis.fetch;
    resetLatestReleaseCache();
    resetWindowsBackendAssetCache();
    resetLinuxX64BackendAssetCache();
    setConfiguredBackendVariant("auto");
    execSyncMock.mockReset();
    execSyncMock.mockImplementation(() => {
      throw new Error("nvidia-smi: not found");
    });
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    while (spies.length) spies.pop()!.mockRestore();
    resetLatestReleaseCache();
    resetWindowsBackendAssetCache();
    resetLinuxX64BackendAssetCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks the stable repo and skips prereleases such as dev-latest", async () => {
    onHost("darwin", "arm64");
    const { listUrls, downloaded } = serve([
      { tag: "dev-latest", publishedAt: "2026-11-10T00:00:00Z", prerelease: true, assets: { [MAC_ASSET]: await serverZip("dev") } },
      { tag: "b10298-2.1.0", publishedAt: "2026-10-27T00:00:00Z", assets: { [MAC_ASSET]: await serverZip("stable") } },
    ]);

    await downloadBackend(dir);

    expect(listUrls[0]).toContain(`/repos/${STABLE_BACKEND_REPO}/releases`);
    expect(downloaded).toEqual([MAC_ASSET]);
    expect(readBackendVersion(dir)?.tag).toBe("b10298-2.1.0");
    expect(readFileSync(resolveServerBinPath(dir, "llama-server"), "utf-8")).toContain("stable");
  });

  it("keeps the Windows on ARM build on the nightly repo, prereleases included", async () => {
    onHost("win32", "arm64");
    const zip = new JSZip();
    zip.file("build/bin/llama-server.exe", Buffer.from("fake"));
    const asset = "llama-turboquant-windows-arm64-cpu.zip";
    const { listUrls } = serve([
      { tag: "turboquant-9ca222f", publishedAt: "2026-10-06T00:00:00Z", prerelease: true, assets: { [asset]: await zip.generateAsync({ type: "nodebuffer" }) } },
    ]);

    await downloadBackend(dir);

    expect(listUrls[0]).toContain(`/repos/${NIGHTLY_BACKEND_REPO}/releases`);
    expect(readBackendVersion(dir)?.asset).toBe(asset);
  });

  it("installs the Linux x64 CUDA 13 build on a current NVIDIA driver", async () => {
    onHost("linux", "x64");
    nvidiaSmi("580.95.05, 8.6");
    const { downloaded } = serve([
      {
        tag: "b10298-2.1.0",
        publishedAt: "2026-10-27T00:00:00Z",
        assets: {
          [LINUX_X64_BACKEND_ASSETS.vulkan]: await serverZip("vulkan"),
          [LINUX_X64_BACKEND_ASSETS.cuda124]: await serverZip("cuda12"),
          [LINUX_X64_BACKEND_ASSETS.cuda133]: await serverZip("cuda13"),
        },
      },
    ]);

    await downloadBackend(dir);

    expect(downloaded).toEqual([LINUX_X64_BACKEND_ASSETS.cuda133]);
    expect(readBackendVersion(dir)?.asset).toBe(LINUX_X64_BACKEND_ASSETS.cuda133);
  });

  it("installs the Linux x64 CPU build when no GPU is found", async () => {
    onHost("linux", "x64");
    // No nvidia-smi, no vulkaninfo: every probe command fails.
    const { downloaded } = serve([
      {
        tag: "b10298-2.1.0",
        publishedAt: "2026-10-27T00:00:00Z",
        assets: {
          [LINUX_X64_BACKEND_ASSETS.cpu]: await serverZip("cpu"),
          [LINUX_X64_BACKEND_ASSETS.vulkan]: await serverZip("vulkan"),
        },
      },
    ]);

    await downloadBackend(dir);

    expect(downloaded).toEqual([LINUX_X64_BACKEND_ASSETS.cpu]);
    expect(readBackendVersion(dir)?.asset).toBe(LINUX_X64_BACKEND_ASSETS.cpu);
  });

  it("falls back to the Vulkan build when no release carries the CUDA zip", async () => {
    onHost("linux", "x64");
    nvidiaSmi("550.54.14, 8.9");
    const { downloaded } = serve([
      { tag: "b10298-2.1.0", publishedAt: "2026-10-27T00:00:00Z", assets: { [LINUX_X64_BACKEND_ASSETS.vulkan]: await serverZip("vulkan") } },
    ]);

    await downloadBackend(dir);

    expect(downloaded).toEqual([LINUX_X64_BACKEND_ASSETS.vulkan]);
    expect(readBackendVersion(dir)?.asset).toBe(LINUX_X64_BACKEND_ASSETS.vulkan);
    // The stand-in is current, not a variant to replace on every start.
    resetLatestReleaseCache();
    const check = await checkForBackendUpdate(dir);
    expect(check.updateAvailable).toBe(false);
    expect(check.latestTag).toBe("b10298-2.1.0");
  });

  it("offers the CUDA build to a Linux x64 machine still on the nightly Vulkan build", async () => {
    onHost("linux", "x64");
    serve([
      { tag: "b10298-2.1.0", publishedAt: "2026-10-27T00:00:00Z", assets: { [LINUX_X64_BACKEND_ASSETS.vulkan]: await serverZip("vulkan") } },
    ]);
    await downloadBackend(dir);

    resetLatestReleaseCache();
    resetLinuxX64BackendAssetCache();
    nvidiaSmi("580.95.05, 8.6");
    serve([
      {
        tag: "b10298-2.1.0",
        publishedAt: "2026-10-27T00:00:00Z",
        assets: {
          [LINUX_X64_BACKEND_ASSETS.vulkan]: await serverZip("vulkan"),
          [LINUX_X64_BACKEND_ASSETS.cuda133]: await serverZip("cuda13"),
        },
      },
    ]);
    const check = await checkForBackendUpdate(dir);
    expect(check.updateAvailable).toBe(true);
  });

  it("recreates the shared-library symlinks the stable Linux zips carry", async () => {
    onHost("linux", "x64");
    nvidiaSmi("550.54.14, 8.9");
    const zip = new JSZip();
    zip.file("build/bin/llama-server", Buffer.from("#!/bin/sh\necho ok\n"), { unixPermissions: 0o100755 });
    zip.file("build/bin/libcudart.so.12.4.127", Buffer.from("ELF cudart"), { unixPermissions: 0o100644 });
    zip.file("build/bin/libcudart.so.12", "libcudart.so.12.4.127", { unixPermissions: 0o120777 });
    zip.file("build/bin/libcudart.so", "libcudart.so.12", { unixPermissions: 0o120777 });
    const buf = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
    serve([
      { tag: "b10298-2.1.0", publishedAt: "2026-10-27T00:00:00Z", assets: { [LINUX_X64_BACKEND_ASSETS.cuda124]: buf } },
    ]);

    await downloadBackend(dir);

    const backend = resolveBackendDir(dir);
    expect(isBackendDownloaded(dir)).toBe(true);
    expect(lstatSync(join(backend, "libcudart.so.12")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(backend, "libcudart.so.12"))).toBe("libcudart.so.12.4.127");
    expect(readFileSync(join(backend, "libcudart.so"), "utf-8")).toBe("ELF cudart");
    expect(existsSync(join(backend, "build"))).toBe(false);
  });

  it("refuses a symlink that points outside the install and keeps the old engine", async () => {
    onHost("darwin", "arm64");
    const zip = new JSZip();
    zip.file("build/bin/llama-server", Buffer.from("#!/bin/sh\n"), { unixPermissions: 0o100755 });
    zip.file("build/bin/libevil.dylib", "../../../../etc/passwd", { unixPermissions: 0o120777 });
    serve([
      { tag: "b10298-2.1.0", publishedAt: "2026-10-27T00:00:00Z", assets: { [MAC_ASSET]: await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }) } },
    ]);

    await expect(downloadBackend(dir)).rejects.toThrow(/symlink leaving the install dir/);
    expect(isBackendDownloaded(dir)).toBe(false);
  });
});
