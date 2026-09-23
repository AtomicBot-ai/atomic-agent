export class UnsupportedPlatformError extends Error {
  constructor(
    public readonly platform: string,
    public readonly arch: string,
  ) {
    super(
      `managed llama.cpp backend is only built for darwin-arm64, linux-x64, linux-arm64, and win32-x64; ` +
        `got ${platform}-${arch}. Use external mode instead.`,
    );
    this.name = "UnsupportedPlatformError";
  }
}

/**
 * The Linux arm64 builds are compiled on Ubuntu 24.04 and reference
 * `GLIBC_2.38` symbols (C23 `__isoc23_strtol` and friends), so they
 * cannot load on an older or non-glibc system. Refusing up front keeps
 * the "use external mode" answer those hosts always had, instead of an
 * install that succeeds and a daemon that dies in the dynamic loader.
 */
export class UnsupportedGlibcError extends UnsupportedPlatformError {
  constructor(public readonly glibcVersion: string | null) {
    super("linux", "arm64");
    this.name = "UnsupportedGlibcError";
    this.message =
      `managed llama.cpp backend for linux-arm64 needs glibc 2.38 or newer ` +
      `(Ubuntu 24.04, Debian 13, DGX OS 7); found ${glibcVersion ?? "no glibc"}. ` +
      `Use external mode instead.`;
  }
}

export interface PlatformAsset {
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  assetName: string;
  binaryName: string;
}

export function resolvePlatformAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformAsset {
  if (platform === "darwin" && arch === "arm64") {
    return {
      platform,
      arch,
      assetName: "llama-turboquant-macos-arm64.zip",
      binaryName: "llama-server",
    };
  }
  if (platform === "linux" && arch === "x64") {
    return {
      platform,
      arch,
      assetName: "llama-turboquant-linux-x64-vulkan.zip",
      binaryName: "llama-server",
    };
  }
  if (platform === "linux" && arch === "arm64") {
    return {
      platform,
      arch,
      assetName: "llama-turboquant-linux-arm64-vulkan.zip",
      binaryName: "llama-server",
    };
  }
  if (platform === "win32" && arch === "x64") {
    return {
      platform,
      arch,
      assetName: "llama-turboquant-windows-x64-vulkan.zip",
      binaryName: "llama-server.exe",
    };
  }
  throw new UnsupportedPlatformError(String(platform), String(arch));
}
