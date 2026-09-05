import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

import {
  WINDOWS_BACKEND_ASSETS,
  isWindowsGpuBackendAsset,
  parseDriverCudaVersion,
  resetWindowsBackendAssetCache,
  resolveDownloadAsset,
  selectWindowsBackendAsset,
  setConfiguredBackendVariant,
} from "./windows-backend-variant.js";

const NVIDIA_SMI_HEADER = `
Mon Jul  6 17:00:00 2026
+-----------------------------------------------------------------------------+
| NVIDIA-SMI 552.22       Driver Version: 552.22       CUDA Version: 12.6     |
|-------------------------------+----------------------+----------------------+
`;

describe("parseDriverCudaVersion", () => {
  it("extracts major.minor from nvidia-smi header", () => {
    expect(parseDriverCudaVersion(NVIDIA_SMI_HEADER)).toEqual({
      major: 12,
      minor: 6,
    });
  });

  it("is case-insensitive and tolerant of spacing", () => {
    expect(parseDriverCudaVersion("cuda version:13.3")).toEqual({
      major: 13,
      minor: 3,
    });
  });

  it("reads the `CUDA UMD Version` field used by driver 610+", () => {
    // Driver 610.x reworked the header: `Driver Version` became `KMD
    // Version` and `CUDA Version` became `CUDA UMD Version`. Matching
    // `CUDA Version:` literally returned null on those boxes, which sent
    // an RTX 5070 Ti to the Vulkan build.
    expect(
      parseDriverCudaVersion(
        "| NVIDIA-SMI 610.47                 KMD Version: 610.47        CUDA UMD Version: 13.3     |",
      ),
    ).toEqual({ major: 13, minor: 3 });
  });

  it("returns null when the field is absent", () => {
    expect(parseDriverCudaVersion("no gpu here")).toBeNull();
  });
});

describe("selectWindowsBackendAsset", () => {
  it("falls back to Vulkan when no driver is detected", () => {
    expect(selectWindowsBackendAsset(null)).toBe(WINDOWS_BACKEND_ASSETS.vulkan);
  });

  it("picks cuda-13.3 for any 13.x driver (minor-version compatibility)", () => {
    // Blackwell (sm_120) exists only in the 13.3 build; a 13.0 driver
    // runs it fine, so it must not be sent to the 12.4 build.
    expect(selectWindowsBackendAsset({ major: 13, minor: 0 })).toBe(
      WINDOWS_BACKEND_ASSETS.cuda133,
    );
    expect(selectWindowsBackendAsset({ major: 13, minor: 3 })).toBe(
      WINDOWS_BACKEND_ASSETS.cuda133,
    );
    expect(selectWindowsBackendAsset({ major: 13, minor: 5 })).toBe(
      WINDOWS_BACKEND_ASSETS.cuda133,
    );
    expect(selectWindowsBackendAsset({ major: 14, minor: 0 })).toBe(
      WINDOWS_BACKEND_ASSETS.cuda133,
    );
  });

  it("picks cuda-12.4 for a 12.x driver at or above 12.4", () => {
    expect(selectWindowsBackendAsset({ major: 12, minor: 4 })).toBe(
      WINDOWS_BACKEND_ASSETS.cuda124,
    );
    expect(selectWindowsBackendAsset({ major: 12, minor: 6 })).toBe(
      WINDOWS_BACKEND_ASSETS.cuda124,
    );
  });

  it("falls back to Vulkan when the driver is older than 12.4", () => {
    expect(selectWindowsBackendAsset({ major: 12, minor: 3 })).toBe(
      WINDOWS_BACKEND_ASSETS.vulkan,
    );
    expect(selectWindowsBackendAsset({ major: 11, minor: 8 })).toBe(
      WINDOWS_BACKEND_ASSETS.vulkan,
    );
  });
});

describe("isWindowsGpuBackendAsset", () => {
  it("recognises the three GPU builds", () => {
    expect(isWindowsGpuBackendAsset(WINDOWS_BACKEND_ASSETS.vulkan)).toBe(true);
    expect(isWindowsGpuBackendAsset(WINDOWS_BACKEND_ASSETS.cuda124)).toBe(true);
    expect(isWindowsGpuBackendAsset(WINDOWS_BACKEND_ASSETS.cuda133)).toBe(true);
  });

  it("rejects the CPU build", () => {
    expect(isWindowsGpuBackendAsset(WINDOWS_BACKEND_ASSETS.cpu)).toBe(false);
  });

  it("treats a pre-`asset`-field install as a GPU build", () => {
    // The CPU zip was not downloadable before the field existed, so an
    // undefined asset on win32 can only be one of the GPU builds.
    expect(isWindowsGpuBackendAsset(undefined)).toBe(true);
  });
});

describe("resolveDownloadAsset", () => {
  beforeEach(() => {
    resetWindowsBackendAssetCache();
    setConfiguredBackendVariant("auto");
    execSyncMock.mockReset();
  });

  afterEach(() => {
    resetWindowsBackendAssetCache();
    setConfiguredBackendVariant("auto");
  });

  it("leaves macOS/Linux assets untouched (no nvidia-smi probe)", () => {
    expect(resolveDownloadAsset("darwin", "arm64").assetName).toBe(
      "llama-turboquant-macos-arm64.zip",
    );
    expect(resolveDownloadAsset("linux", "x64").assetName).toBe(
      "llama-turboquant-linux-x64-vulkan.zip",
    );
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("selects the CUDA build on Windows when the driver supports it", () => {
    execSyncMock.mockReturnValue(Buffer.from(NVIDIA_SMI_HEADER));
    const asset = resolveDownloadAsset("win32", "x64");
    expect(asset.assetName).toBe(WINDOWS_BACKEND_ASSETS.cuda124);
    expect(asset.binaryName).toBe("llama-server.exe");
  });

  it("falls back to Vulkan on Windows when nvidia-smi is missing", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(resolveDownloadAsset("win32", "x64").assetName).toBe(
      WINDOWS_BACKEND_ASSETS.vulkan,
    );
  });

  it("probes nvidia-smi at most once (process-wide cache)", () => {
    execSyncMock.mockReturnValue(Buffer.from(NVIDIA_SMI_HEADER));
    resolveDownloadAsset("win32", "x64");
    resolveDownloadAsset("win32", "x64");
    resolveDownloadAsset("win32", "x64");
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("a configured 'cpu' variant pins the CPU zip without probing nvidia-smi", () => {
    setConfiguredBackendVariant("cpu");
    expect(resolveDownloadAsset("win32", "x64").assetName).toBe(
      WINDOWS_BACKEND_ASSETS.cpu,
    );
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("a configured 'vulkan' variant beats a CUDA-capable driver", () => {
    execSyncMock.mockReturnValue(Buffer.from(NVIDIA_SMI_HEADER));
    setConfiguredBackendVariant("vulkan");
    expect(resolveDownloadAsset("win32", "x64").assetName).toBe(
      WINDOWS_BACKEND_ASSETS.vulkan,
    );
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("a variant configured after detection is not shadowed by the cache", () => {
    // The CPU fallback flips the preference mid-process, after the
    // auto-update path already detected (and cached) a GPU asset.
    execSyncMock.mockReturnValue(Buffer.from(NVIDIA_SMI_HEADER));
    expect(resolveDownloadAsset("win32", "x64").assetName).toBe(
      WINDOWS_BACKEND_ASSETS.cuda124,
    );
    setConfiguredBackendVariant("cpu");
    expect(resolveDownloadAsset("win32", "x64").assetName).toBe(
      WINDOWS_BACKEND_ASSETS.cpu,
    );
  });

  it("returning to 'auto' restores detection", () => {
    execSyncMock.mockReturnValue(Buffer.from(NVIDIA_SMI_HEADER));
    setConfiguredBackendVariant("cpu");
    expect(resolveDownloadAsset("win32", "x64").assetName).toBe(
      WINDOWS_BACKEND_ASSETS.cpu,
    );
    setConfiguredBackendVariant("auto");
    expect(resolveDownloadAsset("win32", "x64").assetName).toBe(
      WINDOWS_BACKEND_ASSETS.cuda124,
    );
  });

  it("ignores the variant preference off Windows (single-asset platforms)", () => {
    setConfiguredBackendVariant("cpu");
    expect(resolveDownloadAsset("darwin", "arm64").assetName).toBe(
      "llama-turboquant-macos-arm64.zip",
    );
    expect(resolveDownloadAsset("linux", "x64").assetName).toBe(
      "llama-turboquant-linux-x64-vulkan.zip",
    );
  });
});
