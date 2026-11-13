import { join } from "node:path";

/**
 * The whisper.cpp build the agent downloads on first use (ATO-702,
 * decision 75), pinned with the SHA-256 GitHub publishes for each asset.
 *
 * Only what upstream ships prebuilt is here. `ggml-org/whisper.cpp`
 * release b5454 (= v1.9.5; the `v1.9.5` tag itself carries no files)
 * has Windows x64 / arm64 zips and Ubuntu x64 / arm64 tarballs, and for
 * macOS only an xcframework (a library, no CLI). So there is no entry
 * for macOS: there the user's `brew install whisper-cpp` stays the route,
 * and the error says so. Neither Atomic Chat Core nor the managed
 * llama.cpp download carries whisper.cpp.
 *
 * The Linux build links glibc 2.34+ and finds its shared libraries next
 * to itself (`$ORIGIN`), so the folder is used as extracted.
 */
export const WHISPER_RELEASE = {
  tag: "b5454",
  version: "1.9.5",
  repo: "ggml-org/whisper.cpp",
} as const;

export interface WhisperAsset {
  name: string;
  format: "zip" | "tar.gz";
  sizeBytes: number;
  sha256: string;
  /** File name of the CLI inside the archive. */
  binary: string;
}

const ASSETS: Readonly<Record<string, WhisperAsset>> = {
  "win32-x64": {
    name: "whisper-bin-x64.zip",
    format: "zip",
    sizeBytes: 8_928_640,
    sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
    binary: "whisper-cli.exe",
  },
  "win32-arm64": {
    name: "whisper-bin-win-cpu-arm64.zip",
    format: "zip",
    sizeBytes: 4_371_193,
    sha256: "28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d",
    binary: "whisper-cli.exe",
  },
  "linux-x64": {
    name: "whisper-bin-ubuntu-x64.tar.gz",
    format: "tar.gz",
    sizeBytes: 10_364_195,
    sha256: "a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c",
    binary: "whisper-cli",
  },
  "linux-arm64": {
    name: "whisper-bin-ubuntu-arm64.tar.gz",
    format: "tar.gz",
    sizeBytes: 4_608_377,
    sha256: "6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149",
    binary: "whisper-cli",
  },
};

/** The prebuilt for this machine, or null where upstream ships none (macOS). */
export function whisperAssetFor(platform: NodeJS.Platform, arch: string): WhisperAsset | null {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

export function whisperAssetUrl(asset: WhisperAsset): string {
  return `https://github.com/${WHISPER_RELEASE.repo}/releases/download/${WHISPER_RELEASE.tag}/${asset.name}`;
}

/** `<models dir>/whisper/bin/<tag>`: one folder per pinned build. */
export function managedWhisperDir(localModelsDataDir: string): string {
  return join(localModelsDataDir, "whisper", "bin", WHISPER_RELEASE.tag);
}

export function managedWhisperBinary(localModelsDataDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(managedWhisperDir(localModelsDataDir), platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
}
