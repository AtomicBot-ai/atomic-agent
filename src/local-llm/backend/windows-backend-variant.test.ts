import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

import { LINUX_ARM64_BACKEND_ASSET } from "./linux-arm64-backend-variant.js";
import {
  UnsupportedGlibcError,
  WINDOWS_ARM64_BACKEND_ASSET,
} from "./platform-assets.js";
import {
  WINDOWS_BACKEND_ASSETS,
  isIncompleteWindowsCudaBackend,
  isWindowsCudaBackendAsset,
  isWindowsGpuBackendAsset,
  parseComputeCapabilities,
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

/** The ATO-244 reporter's header: RTX 3080 Ti on driver 591.44. */
const NVIDIA_SMI_HEADER_13_1 = `
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 591.44                 Driver Version: 591.44         CUDA Version: 13.1     |
+-----------------------------------------+------------------------+----------------------+
`;

const COMPUTE_CAP_QUERY =
  "nvidia-smi --query-gpu=compute_cap --format=csv,noheader";

/**
 * Stub `nvidia-smi`: the bare call prints `header`, the compute-capability
 * query prints `computeCap` (or fails when it is null, as on a driver too
 * old for the field).
 */
function stubNvidiaSmi(header: string, computeCap: string | null): void {
  execSyncMock.mockImplementation((cmd: string) => {
    if (cmd === COMPUTE_CAP_QUERY) {
      if (computeCap === null) {
        throw new Error('Field "compute_cap" is not a valid field to query.');
      }
      return Buffer.from(computeCap);
    }
    if (cmd === "nvidia-smi") return Buffer.from(header);
    throw new Error(`unexpected command: ${cmd}`);
  });
}

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

  it("never picks the cuda-13.3 zip — it ships without its CUDA runtime (ATO-244)", () => {
    // turboquant-6df272c's cuda-13.3 zip has no cudart64_13 / cublas64_13
    // / cublasLt64_13, so on a box without the CUDA Toolkit it loaded no
    // GPU and ran on the CPU. A 13.x driver runs the 12.4 build fine.
    for (const minor of [0, 1, 3, 5]) {
      expect(selectWindowsBackendAsset({ major: 13, minor })).toBe(
        WINDOWS_BACKEND_ASSETS.cuda124,
      );
    }
    expect(selectWindowsBackendAsset({ major: 14, minor: 0 })).toBe(
      WINDOWS_BACKEND_ASSETS.cuda124,
    );
  });

  it("driver 13.1 + Ampere (cc 8.6) → cuda-12.4", () => {
    expect(
      selectWindowsBackendAsset({ major: 13, minor: 1 }, { major: 8, minor: 6 }),
    ).toBe(WINDOWS_BACKEND_ASSETS.cuda124);
  });

  it("keeps Ada and Hopper on cuda-12.4 — the 12.4 toolkit has their code", () => {
    expect(
      selectWindowsBackendAsset({ major: 13, minor: 1 }, { major: 8, minor: 9 }),
    ).toBe(WINDOWS_BACKEND_ASSETS.cuda124);
    expect(
      selectWindowsBackendAsset({ major: 13, minor: 1 }, { major: 9, minor: 0 }),
    ).toBe(WINDOWS_BACKEND_ASSETS.cuda124);
  });

  it("driver 13.1 + Blackwell (cc 12.0, RTX 50-series) → Vulkan", () => {
    // The 12.4 toolkit predates sm_120, and the 13.3 zip lacks its runtime.
    expect(
      selectWindowsBackendAsset({ major: 13, minor: 1 }, { major: 12, minor: 0 }),
    ).toBe(WINDOWS_BACKEND_ASSETS.vulkan);
    expect(
      selectWindowsBackendAsset({ major: 13, minor: 0 }, { major: 10, minor: 0 }),
    ).toBe(WINDOWS_BACKEND_ASSETS.vulkan);
  });

  it("driver 12.4 + unknown compute capability → cuda-12.4", () => {
    expect(selectWindowsBackendAsset({ major: 12, minor: 4 }, null)).toBe(
      WINDOWS_BACKEND_ASSETS.cuda124,
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
    expect(
      selectWindowsBackendAsset({ major: 12, minor: 2 }, { major: 8, minor: 6 }),
    ).toBe(WINDOWS_BACKEND_ASSETS.vulkan);
    expect(selectWindowsBackendAsset({ major: 11, minor: 8 })).toBe(
      WINDOWS_BACKEND_ASSETS.vulkan,
    );
  });
});

describe("parseComputeCapabilities", () => {
  it("reads one GPU", () => {
    expect(parseComputeCapabilities("8.6\n")).toEqual({ major: 8, minor: 6 });
  });

  it("takes the highest of several GPUs (CRLF tolerated)", () => {
    expect(parseComputeCapabilities("8.6\r\n12.0\r\n7.5\r\n")).toEqual({
      major: 12,
      minor: 0,
    });
    expect(parseComputeCapabilities("8.9\n8.6\n")).toEqual({
      major: 8,
      minor: 9,
    });
  });

  it("returns null when nothing parses", () => {
    expect(parseComputeCapabilities("")).toBeNull();
    expect(parseComputeCapabilities("[N/A]\n")).toBeNull();
    expect(parseComputeCapabilities(NVIDIA_SMI_HEADER)).toBeNull();
  });
});

describe("isIncompleteWindowsCudaBackend", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "win-cuda-backend-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const files = (...names: string[]) => {
    for (const n of names) writeFileSync(join(dir, n), "x");
  };

  it("flags a CUDA build with ggml-cuda.dll but no cudart64_*.dll (cuda-13.3 of turboquant-6df272c)", () => {
    files("llama-server.exe", "ggml.dll", "ggml-base.dll", "ggml-cuda.dll");
    expect(isIncompleteWindowsCudaBackend(dir)).toBe(true);
  });

  it("accepts a CUDA build that ships its runtime (cuda-12.4)", () => {
    files(
      "llama-server.exe",
      "ggml-cuda.dll",
      "cudart64_12.dll",
      "cublas64_12.dll",
      "cublasLt64_12.dll",
    );
    expect(isIncompleteWindowsCudaBackend(dir)).toBe(false);
  });

  it("compares names case-insensitively, as Windows does", () => {
    files("llama-server.exe", "GGML-CUDA.DLL", "CudaRT64_12.dll");
    expect(isIncompleteWindowsCudaBackend(dir)).toBe(false);
  });

  it("never flags a build without ggml-cuda.dll (Vulkan, CPU)", () => {
    files("llama-server.exe", "ggml-vulkan.dll");
    expect(isIncompleteWindowsCudaBackend(dir)).toBe(false);
  });

  it("never flags a dir that does not exist", () => {
    expect(isIncompleteWindowsCudaBackend(join(dir, "missing"))).toBe(false);
  });
});

describe("isWindowsCudaBackendAsset", () => {
  it("is true for the two CUDA zips only", () => {
    expect(isWindowsCudaBackendAsset(WINDOWS_BACKEND_ASSETS.cuda124)).toBe(true);
    expect(isWindowsCudaBackendAsset(WINDOWS_BACKEND_ASSETS.cuda133)).toBe(true);
    expect(isWindowsCudaBackendAsset(WINDOWS_BACKEND_ASSETS.vulkan)).toBe(false);
    expect(isWindowsCudaBackendAsset(WINDOWS_BACKEND_ASSETS.cpu)).toBe(false);
    expect(isWindowsCudaBackendAsset(undefined)).toBe(false);
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

  it("rejects the Windows arm64 build (CPU only, ATO-252)", () => {
    expect(isWindowsGpuBackendAsset(WINDOWS_ARM64_BACKEND_ASSET)).toBe(false);
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

  it("probes nvidia-smi at most once per query (process-wide cache)", () => {
    stubNvidiaSmi(NVIDIA_SMI_HEADER, "8.6\n");
    resolveDownloadAsset("win32", "x64");
    resolveDownloadAsset("win32", "x64");
    resolveDownloadAsset("win32", "x64");
    // The driver header once, the compute capability once.
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });

  it("driver 13.1 + RTX 3080 Ti (cc 8.6) → cuda-12.4 (the ATO-244 machine)", () => {
    stubNvidiaSmi(NVIDIA_SMI_HEADER_13_1, "8.6\n");
    expect(resolveDownloadAsset("win32", "x64").assetName).toBe(
      WINDOWS_BACKEND_ASSETS.cuda124,
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      COMPUTE_CAP_QUERY,
      expect.anything(),
    );
  });

  it("driver 13.1 + RTX 50-series (cc 12.0) → Vulkan", () => {
    stubNvidiaSmi(NVIDIA_SMI_HEADER_13_1, "12.0\n");
    expect(resolveDownloadAsset("win32", "x64").assetName).toBe(
      WINDOWS_BACKEND_ASSETS.vulkan,
    );
  });

  it("a mixed box goes by its newest GPU", () => {
    stubNvidiaSmi(NVIDIA_SMI_HEADER_13_1, "8.6\n12.0\n");
    expect(resolveDownloadAsset("win32", "x64").assetName).toBe(
      WINDOWS_BACKEND_ASSETS.vulkan,
    );
  });

  it("driver 12.4 + a failing compute-capability query → cuda-12.4", () => {
    stubNvidiaSmi(
      "| NVIDIA-SMI 551.23   Driver Version: 551.23   CUDA Version: 12.4 |",
      null,
    );
    expect(resolveDownloadAsset("win32", "x64").assetName).toBe(
      WINDOWS_BACKEND_ASSETS.cuda124,
    );
  });

  it("driver 12.2 → Vulkan, without asking for the compute capability", () => {
    stubNvidiaSmi(
      "| NVIDIA-SMI 537.13   Driver Version: 537.13   CUDA Version: 12.2 |",
      "8.6\n",
    );
    expect(resolveDownloadAsset("win32", "x64").assetName).toBe(
      WINDOWS_BACKEND_ASSETS.vulkan,
    );
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

  it("resolves linux arm64 to the one published arm64 build", () => {
    const asset = resolveDownloadAsset("linux", "arm64", "2.39");
    expect(asset.assetName).toBe(LINUX_ARM64_BACKEND_ASSET);
    expect(asset.binaryName).toBe("llama-server");
  });

  it("probes no hardware on linux arm64 — there is nothing to choose", () => {
    resolveDownloadAsset("linux", "arm64", "2.39");
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("refuses linux arm64 on a glibc older than the arm64 build needs", () => {
    expect(() => resolveDownloadAsset("linux", "arm64", "2.35")).toThrow(
      UnsupportedGlibcError,
    );
    expect(() => resolveDownloadAsset("linux", "arm64", null)).toThrow(
      /needs glibc 2\.38 or newer.*found no glibc/,
    );
  });

  it("ignores the variant preference on linux arm64 (single asset)", () => {
    // Every value has to land on the same asset: arm64 publishes one
    // build, so a pin that named another would ask for a file that does
    // not exist in any release.
    for (const pin of ["vulkan", "cpu", "cuda-12.4", "cuda-13.3"] as const) {
      setConfiguredBackendVariant(pin);
      expect(resolveDownloadAsset("linux", "arm64", "2.39").assetName).toBe(
        LINUX_ARM64_BACKEND_ASSET,
      );
    }
    expect(execSyncMock).not.toHaveBeenCalled();
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

  // ATO-252: the x64 zips the probe and the variants choose between cannot
  // run on Windows arm64; its one CPU build is the answer every time.
  it("keeps the arm64 CPU build on Windows arm64, with no nvidia-smi probe", () => {
    execSyncMock.mockReturnValue(Buffer.from(NVIDIA_SMI_HEADER));
    const asset = resolveDownloadAsset("win32", "arm64");
    expect(asset.assetName).toBe(WINDOWS_ARM64_BACKEND_ASSET);
    expect(asset.binaryName).toBe("llama-server.exe");
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("ignores every configured variant on Windows arm64", () => {
    for (const v of ["cpu", "vulkan", "cuda-12.4", "cuda-13.3"] as const) {
      setConfiguredBackendVariant(v);
      expect(resolveDownloadAsset("win32", "arm64").assetName).toBe(
        WINDOWS_ARM64_BACKEND_ASSET,
      );
    }
    expect(execSyncMock).not.toHaveBeenCalled();
  });
});
