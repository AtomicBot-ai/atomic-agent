import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

import {
  WINDOWS_BACKEND_ASSETS,
  parseDriverCudaVersion,
  resetWindowsBackendAssetCache,
  resolveDownloadAsset,
  selectWindowsBackendAsset,
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

describe("resolveDownloadAsset", () => {
  beforeEach(() => {
    resetWindowsBackendAssetCache();
    execSyncMock.mockReset();
  });

  afterEach(() => {
    resetWindowsBackendAssetCache();
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
});
