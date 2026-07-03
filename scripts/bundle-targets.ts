/**
 * Single source of truth for the supported bundling matrix. CI pipelines
 * and local scripts import this list so we never hand-maintain separate
 * target definitions.
 */
export type NodePlatform = "darwin" | "linux" | "win32";
export type NodeArch = "x64" | "arm64";

export interface BundleTarget {
  platform: NodePlatform;
  arch: NodeArch;
  slug: string;
  executableName: string;
  archiveExt: "tar.gz" | "zip";
  /**
   * Rust target triple. Tauri names sidecar binaries
   * `binaries/<name>-<rustTriple>[.exe]` and appends the host triple at build
   * time (see `scripts/build-tauri-sidecar.ts`).
   */
  rustTriple: string;
}

export const BUNDLE_TARGETS: readonly BundleTarget[] = [
  {
    platform: "darwin",
    arch: "arm64",
    slug: "darwin-arm64",
    executableName: "atomic-agent",
    archiveExt: "tar.gz",
    rustTriple: "aarch64-apple-darwin",
  },
  {
    platform: "darwin",
    arch: "x64",
    slug: "darwin-x64",
    executableName: "atomic-agent",
    archiveExt: "tar.gz",
    rustTriple: "x86_64-apple-darwin",
  },
  {
    platform: "linux",
    arch: "x64",
    slug: "linux-x64",
    executableName: "atomic-agent",
    archiveExt: "tar.gz",
    rustTriple: "x86_64-unknown-linux-gnu",
  },
  {
    platform: "linux",
    arch: "arm64",
    slug: "linux-arm64",
    executableName: "atomic-agent",
    archiveExt: "tar.gz",
    rustTriple: "aarch64-unknown-linux-gnu",
  },
  {
    platform: "win32",
    arch: "x64",
    slug: "win32-x64",
    executableName: "atomic-agent.exe",
    archiveExt: "zip",
    rustTriple: "x86_64-pc-windows-msvc",
  },
];

export function currentTarget(): BundleTarget {
  const platform = process.platform as NodePlatform;
  const arch = process.arch as NodeArch;
  const match = BUNDLE_TARGETS.find((t) => t.platform === platform && t.arch === arch);
  if (!match) {
    throw new Error(
      `unsupported build host: platform=${platform} arch=${arch}. Expand BUNDLE_TARGETS to add support.`,
    );
  }
  return match;
}
