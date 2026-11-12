export class UnsupportedPlatformError extends Error {
  constructor(
    public readonly platform: string,
    public readonly arch: string,
  ) {
    super(
      `managed llama.cpp backend is only built for darwin-arm64, linux-x64, linux-arm64, win32-x64, and win32-arm64; ` +
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

/**
 * ATO-252: the Windows on ARM builds. CPU only: the turboquant repo
 * publishes no Vulkan or CUDA build for arm64, so
 * `localModels.managed.backendVariant` is ignored there (see
 * `resolveDownloadAsset`) and there is no GPU build to fall back from
 * (`cpu-backend-fallback.ts`). Same layout as the x64 zips
 * (`build/bin/llama-server.exe`).
 *
 * ATO-253: two of them. `WINDOWS_ARM64_BACKEND_ASSET` is compiled with
 * `-march=armv8.7-a` and dies with an illegal instruction on anything
 * older than Snapdragon X (8cx Gen 1-3, Surface Pro X, Dev Kit 2023);
 * `WINDOWS_ARM64_COMPAT_BACKEND_ASSET` (`armv8.2-a+dotprod`) runs on every
 * Windows on ARM machine. Which one a machine gets is decided in
 * `windows-arm64-backend-variant.ts`.
 */
export const WINDOWS_ARM64_BACKEND_ASSET =
  "llama-turboquant-windows-arm64-cpu.zip";
export const WINDOWS_ARM64_COMPAT_BACKEND_ASSET =
  "llama-turboquant-windows-arm64-cpu-compat.zip";

/**
 * What a Windows on ARM machine is told when no engine release carries
 * an arm64 build it can run: the app itself runs, only local
 * models do not. One sentence for the CLI, the TUI and the desktop (which
 * finds it in `models update`'s stderr), so they cannot drift apart.
 */
export const WINDOWS_ARM64_NO_BACKEND_MESSAGE =
  "Local models are not available yet for Windows on ARM. Use a cloud model instead.";

/** True for the one platform whose engine build may not be published yet. */
export function isWindowsArm64(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return platform === "win32" && arch === "arm64";
}

export interface PlatformAsset {
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  assetName: string;
  binaryName: string;
  /**
   * Other archives that also run on this machine, best first, for a
   * release that lacks `assetName`. Only Windows arm64 sets it (ATO-253).
   */
  alternateAssetNames?: readonly string[];
}

/** `assetName` followed by `alternateAssetNames`: every archive this machine can use, best first. */
export function acceptableAssetNames(asset: PlatformAsset): string[] {
  return [asset.assetName, ...(asset.alternateAssetNames ?? [])];
}

/**
 * The archive this machine wants, judged without a release in hand:
 * `installed` when it is one of the archives that run here, otherwise the
 * best one. Lets a Windows arm64 install of its second-choice build stand
 * between full release checks, which pick exactly (ATO-253). Everywhere
 * else this is just `asset.assetName`.
 */
export function wantedAssetForInstalled(
  asset: PlatformAsset,
  installed: string | undefined,
): string {
  return installed !== undefined && acceptableAssetNames(asset).includes(installed)
    ? installed
    : asset.assetName;
}

/**
 * The best archive of `release` for this machine, or null when it carries
 * none of `acceptableAssetNames(asset)`.
 */
export function pickReleaseAssetName(
  releaseAssetNames: readonly string[],
  asset: PlatformAsset,
): string | null {
  return (
    acceptableAssetNames(asset).find((n) => releaseAssetNames.includes(n)) ??
    null
  );
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
    // The one published arm64 build. Named for its GPU backend, but it
    // carries the dispatched CPU backends too and `dlopen`s CUDA, so it
    // serves a box with no NVIDIA driver as well — see
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
  if (platform === "win32" && arch === "arm64") {
    // The build every Windows on ARM CPU runs. `resolveDownloadAsset`
    // upgrades it to the armv8.7 build only when the CPU proves it can.
    return {
      platform,
      arch,
      assetName: WINDOWS_ARM64_COMPAT_BACKEND_ASSET,
      binaryName: "llama-server.exe",
    };
  }
  throw new UnsupportedPlatformError(String(platform), String(arch));
}
