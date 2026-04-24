export class UnsupportedPlatformError extends Error {
  constructor(
    public readonly platform: string,
    public readonly arch: string,
  ) {
    super(
      `managed llama.cpp backend is only built for darwin-arm64 and win32-x64; ` +
        `got ${platform}-${arch}. Use external mode instead.`,
    );
    this.name = "UnsupportedPlatformError";
  }
}

export interface PlatformAsset {
  platform: "darwin" | "win32";
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
  if (platform === "win32" && arch === "x64") {
    return {
      platform,
      arch,
      assetName: "llama-turboquant-windows-x64.zip",
      binaryName: "llama-server.exe",
    };
  }
  throw new UnsupportedPlatformError(String(platform), String(arch));
}
