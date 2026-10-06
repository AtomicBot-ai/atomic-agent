import { describe, expect, it, vi } from "vitest";

import {
  isWindowsArm64,
  resolvePlatformAsset,
  UnsupportedPlatformError,
  WINDOWS_ARM64_BACKEND_ASSET,
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

  it("resolves win32 arm64 to the CPU-only arm64 asset (ATO-252)", () => {
    const a = resolvePlatformAsset("win32", "arm64");
    expect(a.assetName).toBe("llama-turboquant-windows-arm64-cpu.zip");
    expect(a.assetName).toBe(WINDOWS_ARM64_BACKEND_ASSET);
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
      expect(resolvePlatformAsset().assetName).toBe(WINDOWS_ARM64_BACKEND_ASSET);
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
