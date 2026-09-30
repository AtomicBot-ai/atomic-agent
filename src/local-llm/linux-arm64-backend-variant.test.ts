import { describe, expect, it } from "vitest";

import {
  LINUX_ARM64_BACKEND_ASSET,
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

describe("LINUX_ARM64_BACKEND_ASSET", () => {
  // The defect this pins: an earlier shape asked for
  // `llama-turboquant-linux-arm64-vulkan.zip`, which exists in none of
  // the turboquant releases. `backend-installer.ts` matches releases on
  // the exact asset name, so naming an unpublished asset turns every
  // arm64 install into "No release found containing asset …".
  it("is the one arm64 asset the turboquant repo actually publishes", () => {
    expect(LINUX_ARM64_BACKEND_ASSET).toBe(
      "llama-turboquant-linux-arm64-cuda-13.3.zip",
    );
  });

  it("is what resolvePlatformAsset hands linux arm64", () => {
    const asset = resolvePlatformAsset("linux", "arm64");
    expect(asset.assetName).toBe(LINUX_ARM64_BACKEND_ASSET);
    expect(asset.binaryName).toBe("llama-server");
  });

  it("names no arm64 build that is not published", () => {
    expect(LINUX_ARM64_BACKEND_ASSET).not.toContain("vulkan");
    expect(LINUX_ARM64_BACKEND_ASSET).not.toContain("cpu");
    expect(LINUX_ARM64_BACKEND_ASSET).not.toContain("cuda-12.4");
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
