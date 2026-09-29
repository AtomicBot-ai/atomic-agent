import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

import {
  LINUX_ARM64_BACKEND_ASSET,
  LINUX_ARM64_BACKEND_ASSETS,
  detectLinuxArm64BackendAsset,
  parseComputeCaps,
  resetLinuxArm64BackendAssetCache,
  selectLinuxArm64BackendAsset,
  LINUX_ARM64_MIN_GLIBC,
  assertLinuxArm64Glibc,
  isSupportedGlibc,
  linuxArm64ManagedSupport,
} from "./linux-arm64-backend-variant.js";
import {
  UnsupportedGlibcError,
  UnsupportedPlatformError,
  resolvePlatformAsset,
} from "./platform-assets.js";

describe("LINUX_ARM64_BACKEND_ASSETS", () => {
  // Both names must match the assets the turboquant nightly publishes
  // (turboquant-29d8598 onward): backend-installer.ts matches releases
  // on the exact asset name.
  it("names the two published arm64 builds", () => {
    expect(LINUX_ARM64_BACKEND_ASSETS).toEqual({
      cuda133: "llama-turboquant-linux-arm64-cuda-13.3.zip",
      vulkan: "llama-turboquant-linux-arm64-vulkan.zip",
    });
  });

  it("keeps the CUDA build as what resolvePlatformAsset hands linux arm64", () => {
    const asset = resolvePlatformAsset("linux", "arm64");
    expect(asset.assetName).toBe(LINUX_ARM64_BACKEND_ASSET);
    expect(LINUX_ARM64_BACKEND_ASSET).toBe(LINUX_ARM64_BACKEND_ASSETS.cuda133);
    expect(asset.binaryName).toBe("llama-server");
  });
});

describe("parseComputeCaps", () => {
  it("reads one capability per GPU line", () => {
    expect(parseComputeCaps("12.1\n")).toEqual(["12.1"]);
    expect(parseComputeCaps("9.0\r\n9.0\r\n")).toEqual(["9.0", "9.0"]);
  });

  it("drops lines that are not a capability", () => {
    expect(parseComputeCaps("[N/A]\n\n")).toEqual([]);
  });
});

describe("selectLinuxArm64BackendAsset", () => {
  it("picks the CUDA build for GB10 (compute capability 12.1)", () => {
    expect(selectLinuxArm64BackendAsset(["12.1"])).toBe(
      LINUX_ARM64_BACKEND_ASSETS.cuda133,
    );
  });

  it("keeps GPUs the CUDA build has no kernels for on Vulkan", () => {
    // GH200 (9.0) and Jetson Thor (11.0) run a CUDA 13 driver too; the
    // sm_121a-only CUDA build would load and fail on its first kernel.
    expect(selectLinuxArm64BackendAsset(["9.0"])).toBe(
      LINUX_ARM64_BACKEND_ASSETS.vulkan,
    );
    expect(selectLinuxArm64BackendAsset(["11.0"])).toBe(
      LINUX_ARM64_BACKEND_ASSETS.vulkan,
    );
  });

  it("uses Vulkan when no NVIDIA GPU is detected", () => {
    expect(selectLinuxArm64BackendAsset(null)).toBe(
      LINUX_ARM64_BACKEND_ASSETS.vulkan,
    );
  });
});

describe("detectLinuxArm64BackendAsset", () => {
  beforeEach(() => {
    resetLinuxArm64BackendAssetCache();
    execSyncMock.mockReset();
  });

  afterEach(() => {
    resetLinuxArm64BackendAssetCache();
  });

  it("asks nvidia-smi for the compute capability", () => {
    execSyncMock.mockReturnValue(Buffer.from("12.1\n"));
    expect(detectLinuxArm64BackendAsset("auto")).toBe(
      LINUX_ARM64_BACKEND_ASSETS.cuda133,
    );
    expect(execSyncMock.mock.calls[0]?.[0]).toContain("--query-gpu=compute_cap");
  });

  it("treats a missing or failing nvidia-smi as no NVIDIA GPU", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detectLinuxArm64BackendAsset("auto")).toBe(
      LINUX_ARM64_BACKEND_ASSETS.vulkan,
    );
  });

  it("probes nvidia-smi at most once per process", () => {
    execSyncMock.mockReturnValue(Buffer.from("12.1\n"));
    detectLinuxArm64BackendAsset("auto");
    detectLinuxArm64BackendAsset("auto");
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("pins 'vulkan' and 'cuda-13.3' without probing", () => {
    expect(detectLinuxArm64BackendAsset("vulkan")).toBe(
      LINUX_ARM64_BACKEND_ASSETS.vulkan,
    );
    expect(detectLinuxArm64BackendAsset("cuda-13.3")).toBe(
      LINUX_ARM64_BACKEND_ASSETS.cuda133,
    );
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("detects for pins that name no arm64 build", () => {
    execSyncMock.mockReturnValue(Buffer.from("12.1\n"));
    expect(detectLinuxArm64BackendAsset("cpu")).toBe(
      LINUX_ARM64_BACKEND_ASSETS.cuda133,
    );
  });
});

describe("glibc floor", () => {
  it("is the 2.38 the published binaries reference", () => {
    expect(LINUX_ARM64_MIN_GLIBC).toEqual({ major: 2, minor: 38 });
  });

  it("accepts glibc 2.38 and newer", () => {
    expect(isSupportedGlibc("2.38")).toBe(true);
    expect(isSupportedGlibc("2.39")).toBe(true);
    expect(isSupportedGlibc("2.41")).toBe(true);
    expect(isSupportedGlibc("3.0")).toBe(true);
  });

  it("rejects older glibc and a missing one (musl)", () => {
    // Ubuntu 22.04 / JetPack 6, Debian 12, Amazon Linux 2023.
    expect(isSupportedGlibc("2.35")).toBe(false);
    expect(isSupportedGlibc("2.36")).toBe(false);
    expect(isSupportedGlibc("2.34")).toBe(false);
    expect(isSupportedGlibc(null)).toBe(false);
  });

  it("reads a version string with a suffix", () => {
    expect(isSupportedGlibc("2.39-0ubuntu8.3")).toBe(true);
    expect(isSupportedGlibc("2.35-0ubuntu3")).toBe(false);
  });

  it("throws an UnsupportedPlatformError naming the floor and the way out", () => {
    expect(() => assertLinuxArm64Glibc("2.36")).toThrow(
      UnsupportedPlatformError,
    );
    expect(() => assertLinuxArm64Glibc("2.36")).toThrow(UnsupportedGlibcError);
    // The whole point of the refusal is that the operator learns what to
    // do instead, so the sentence is asserted, not just the type.
    expect(() => assertLinuxArm64Glibc("2.36")).toThrow(/glibc 2\.38 or newer/);
    expect(() => assertLinuxArm64Glibc("2.36")).toThrow(/found 2\.36/);
    expect(() => assertLinuxArm64Glibc(null)).toThrow(/found no glibc/);
    expect(() => assertLinuxArm64Glibc("2.36")).toThrow(
      /localModels\.mode = "external"/,
    );
    expect(() => assertLinuxArm64Glibc("2.39")).not.toThrow();
  });
});

describe("linuxArm64ManagedSupport", () => {
  it("answers without throwing, for surfaces that only explain themselves", () => {
    expect(linuxArm64ManagedSupport("2.39")).toEqual({
      supported: true,
      glibcVersion: "2.39",
    });
    expect(linuxArm64ManagedSupport("2.31")).toEqual({
      supported: false,
      glibcVersion: "2.31",
    });
    expect(linuxArm64ManagedSupport(null)).toEqual({
      supported: false,
      glibcVersion: null,
    });
  });
});
