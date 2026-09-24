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
 * Oldest glibc the Linux arm64 build loads on. Read out of the published
 * zip rather than taken on trust: `libggml-base.so` and
 * `libllama-server-impl.so` both carry `GLIBC_2.38` version references.
 * Lives here, next to the error that quotes it, so the number and the
 * sentence cannot drift apart; `linux-arm64-backend-variant.ts` compares
 * against it.
 */
export const LINUX_ARM64_MIN_GLIBC = { major: 2, minor: 38 } as const;

/**
 * Refusal for a Linux arm64 host whose glibc cannot load the arm64
 * build. Raised before the download, not after: the alternative is a
 * 554 MB install that succeeds and a daemon that dies in the dynamic
 * loader with a bare `symbol not found`.
 *
 * It extends `UnsupportedPlatformError` so every existing handler that
 * already knows "managed mode cannot serve this machine, offer external
 * mode" catches it unchanged.
 */
export class UnsupportedGlibcError extends UnsupportedPlatformError {
  constructor(public readonly glibcVersion: string | null) {
    super("linux", "arm64");
    this.name = "UnsupportedGlibcError";
    this.message =
      `managed llama.cpp backend for linux-arm64 needs glibc ` +
      `${LINUX_ARM64_MIN_GLIBC.major}.${LINUX_ARM64_MIN_GLIBC.minor} or newer ` +
      `(Ubuntu 24.04, Debian 13, DGX OS 7); found ${glibcVersion ?? "no glibc"}. ` +
      `Use external mode instead: start llama-server yourself and point the agent at it ` +
      `with localModels.mode = "external".`;
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
    // The GB10 CUDA build. `resolveDownloadAsset` swaps in the arm64
    // Vulkan build for any other machine — see
    // `linux-arm64-backend-variant.ts`.
    return {
      platform,
      arch,
      assetName: "llama-turboquant-linux-arm64-cuda-13.3.zip",
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
