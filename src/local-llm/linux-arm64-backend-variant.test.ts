import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

import {
  LINUX_ARM64_BACKEND_ASSETS,
  assertLinuxArm64Glibc,
  detectLinuxArm64BackendAsset,
  isSupportedGlibc,
  parseComputeCaps,
  resetLinuxArm64BackendAssetCache,
  selectLinuxArm64BackendAsset,
} from "./linux-arm64-backend-variant.js";
import { UnsupportedPlatformError } from "./platform-assets.js";

describe("parseComputeCaps", () => {
  it("reads one capability per GPU line", () => {
    expect(parseComputeCaps("12.1\n")).toEqual(["12.1"]);
    expect(parseComputeCaps("9.0\r\n9.0\r\n")).toEqual(["9.0", "9.0"]);
  });

  it("drops lines that are not a capability", () => {
    expect(parseComputeCaps("[N/A]\n\n")).toEqual([]);
    expect(
      parseComputeCaps("Field \"compute_cap\" is not a valid field to query."),
    ).toEqual([]);
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
    // arm64 CUDA build would load and then fail on its first kernel.
    expect(selectLinuxArm64BackendAsset(["9.0"])).toBe(
      LINUX_ARM64_BACKEND_ASSETS.vulkan,
    );
    expect(selectLinuxArm64BackendAsset(["11.0"])).toBe(
      LINUX_ARM64_BACKEND_ASSETS.vulkan,
    );
  });

  it("falls back to Vulkan when no NVIDIA GPU is detected", () => {
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

  it("queries nvidia-smi for compute capabilities", () => {
    execSyncMock.mockReturnValue(Buffer.from("12.1\n"));
    expect(detectLinuxArm64BackendAsset("auto")).toBe(
      LINUX_ARM64_BACKEND_ASSETS.cuda133,
    );
    expect(execSyncMock.mock.calls[0]?.[0]).toContain(
      "--query-gpu=compute_cap",
    );
  });

  it("treats an nvidia-smi failure as no NVIDIA GPU", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detectLinuxArm64BackendAsset("auto")).toBe(
      LINUX_ARM64_BACKEND_ASSETS.vulkan,
    );
  });

  it("probes nvidia-smi at most once (process-wide cache)", () => {
    execSyncMock.mockReturnValue(Buffer.from("12.1\n"));
    detectLinuxArm64BackendAsset("auto");
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
    resetLinuxArm64BackendAssetCache();
    expect(detectLinuxArm64BackendAsset("cuda-12.4")).toBe(
      LINUX_ARM64_BACKEND_ASSETS.cuda133,
    );
  });
});

describe("glibc floor", () => {
  it("accepts glibc 2.38 and newer", () => {
    expect(isSupportedGlibc("2.38")).toBe(true);
    expect(isSupportedGlibc("2.39")).toBe(true);
    expect(isSupportedGlibc("3.0")).toBe(true);
  });

  it("rejects older glibc and a missing one (musl)", () => {
    // Ubuntu 22.04 / JetPack 6, Debian 12, Amazon Linux 2023.
    expect(isSupportedGlibc("2.35")).toBe(false);
    expect(isSupportedGlibc("2.36")).toBe(false);
    expect(isSupportedGlibc("2.34")).toBe(false);
    expect(isSupportedGlibc(null)).toBe(false);
  });

  it("throws an UnsupportedPlatformError that points at external mode", () => {
    expect(() => assertLinuxArm64Glibc("2.36")).toThrow(UnsupportedPlatformError);
    expect(() => assertLinuxArm64Glibc("2.36")).toThrow(/Use external mode/);
    expect(() => assertLinuxArm64Glibc("2.39")).not.toThrow();
  });
});
