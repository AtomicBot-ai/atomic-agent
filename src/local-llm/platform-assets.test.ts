import { describe, expect, it } from "vitest";

import { resolvePlatformAsset, UnsupportedPlatformError } from "./platform-assets.js";

describe("platform-assets", () => {
  it("resolves darwin arm64", () => {
    const a = resolvePlatformAsset("darwin", "arm64");
    expect(a.assetName).toBe("llama-turboquant-macos-arm64.zip");
    expect(a.binaryName).toBe("llama-server");
  });

  it("resolves win32 x64", () => {
    const a = resolvePlatformAsset("win32", "x64");
    expect(a.assetName).toBe("llama-turboquant-windows-x64.zip");
    expect(a.binaryName).toBe("llama-server.exe");
  });

  it("throws on linux", () => {
    expect(() => resolvePlatformAsset("linux", "x64")).toThrow(UnsupportedPlatformError);
  });

  it("throws on darwin x64 (Intel)", () => {
    expect(() => resolvePlatformAsset("darwin", "x64")).toThrow(UnsupportedPlatformError);
  });
});
