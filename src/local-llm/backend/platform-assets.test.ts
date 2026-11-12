import { describe, expect, it, vi } from "vitest";

import {
  acceptableAssetNames,
  isWindowsArm64,
  pickReleaseAssetName,
  resolvePlatformAsset,
  UnsupportedPlatformError,
  wantedAssetForInstalled,
  WINDOWS_ARM64_BACKEND_ASSET,
  WINDOWS_ARM64_COMPAT_BACKEND_ASSET,
  type PlatformAsset,
} from "./platform-assets.js";

describe("platform-assets", () => {
  it("resolves darwin arm64", () => {
    const a = resolvePlatformAsset("darwin", "arm64");
    expect(a.assetName).toBe("llama-turboquant-macos-arm64.zip");
    expect(a.binaryName).toBe("llama-server");
  });

  it("resolves win32 x64 to the Vulkan asset", () => {
    const a = resolvePlatformAsset("win32", "x64");
    expect(a.assetName).toBe("llama-turboquant-windows-x64-vulkan.zip");
    expect(a.binaryName).toBe("llama-server.exe");
  });

  it("resolves linux x64 to the Vulkan asset", () => {
    const a = resolvePlatformAsset("linux", "x64");
    expect(a.assetName).toBe("llama-turboquant-linux-x64-vulkan.zip");
    expect(a.binaryName).toBe("llama-server");
  });

  it("throws on darwin x64 (Intel)", () => {
    expect(() => resolvePlatformAsset("darwin", "x64")).toThrow(
      UnsupportedPlatformError,
    );
  });

  it("resolves linux arm64 to the one published arm64 asset", () => {
    const a = resolvePlatformAsset("linux", "arm64");
    expect(a.assetName).toBe("llama-turboquant-linux-arm64-cuda-13.3.zip");
    expect(a.binaryName).toBe("llama-server");
  });

  // ATO-253: without a CPU probe the safe answer is the build every
  // Windows on ARM CPU runs; `resolveDownloadAsset` may upgrade it.
  it("resolves win32 arm64 to the compat CPU-only arm64 asset (ATO-252, ATO-253)", () => {
    const a = resolvePlatformAsset("win32", "arm64");
    expect(a.assetName).toBe("llama-turboquant-windows-arm64-cpu-compat.zip");
    expect(a.assetName).toBe(WINDOWS_ARM64_COMPAT_BACKEND_ASSET);
    expect(a.alternateAssetNames).toBeUndefined();
    expect(a.binaryName).toBe("llama-server.exe");
    expect(a.platform).toBe("win32");
    expect(a.arch).toBe("arm64");
  });

  it("takes the running process's platform and arch by default", () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    try {
      expect(resolvePlatformAsset().assetName).toBe(
        WINDOWS_ARM64_COMPAT_BACKEND_ASSET,
      );
      expect(isWindowsArm64()).toBe(true);
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it("isWindowsArm64 is true for win32 arm64 only", () => {
    expect(isWindowsArm64("win32", "arm64")).toBe(true);
    expect(isWindowsArm64("win32", "x64")).toBe(false);
    expect(isWindowsArm64("darwin", "arm64")).toBe(false);
    expect(isWindowsArm64("linux", "arm64")).toBe(false);
  });

  it("still throws on win32 ia32", () => {
    expect(() => resolvePlatformAsset("win32", "ia32")).toThrow(
      UnsupportedPlatformError,
    );
  });
});

describe("acceptable assets (ATO-253)", () => {
  const arm64: PlatformAsset = {
    platform: "win32",
    arch: "arm64",
    assetName: WINDOWS_ARM64_BACKEND_ASSET,
    binaryName: "llama-server.exe",
    alternateAssetNames: [WINDOWS_ARM64_COMPAT_BACKEND_ASSET],
  };
  const mac = resolvePlatformAsset("darwin", "arm64");

  it("lists the best asset first, then the alternates", () => {
    expect(acceptableAssetNames(arm64)).toEqual([
      WINDOWS_ARM64_BACKEND_ASSET,
      WINDOWS_ARM64_COMPAT_BACKEND_ASSET,
    ]);
    expect(acceptableAssetNames(mac)).toEqual([mac.assetName]);
  });

  it("picks the best asset a release carries, or null", () => {
    expect(
      pickReleaseAssetName(
        [WINDOWS_ARM64_COMPAT_BACKEND_ASSET, WINDOWS_ARM64_BACKEND_ASSET],
        arm64,
      ),
    ).toBe(WINDOWS_ARM64_BACKEND_ASSET);
    expect(
      pickReleaseAssetName([WINDOWS_ARM64_COMPAT_BACKEND_ASSET], arm64),
    ).toBe(WINDOWS_ARM64_COMPAT_BACKEND_ASSET);
    expect(
      pickReleaseAssetName(["llama-turboquant-windows-x64-vulkan.zip"], arm64),
    ).toBeNull();
  });

  it("keeps an installed alternate, and wants the best asset otherwise", () => {
    expect(
      wantedAssetForInstalled(arm64, WINDOWS_ARM64_COMPAT_BACKEND_ASSET),
    ).toBe(WINDOWS_ARM64_COMPAT_BACKEND_ASSET);
    expect(
      wantedAssetForInstalled(arm64, "llama-turboquant-windows-x64-cpu.zip"),
    ).toBe(WINDOWS_ARM64_BACKEND_ASSET);
    expect(wantedAssetForInstalled(arm64, undefined)).toBe(
      WINDOWS_ARM64_BACKEND_ASSET,
    );
    expect(wantedAssetForInstalled(mac, "something-else.zip")).toBe(
      mac.assetName,
    );
  });
});
