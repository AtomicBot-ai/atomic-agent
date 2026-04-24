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
}

export const BUNDLE_TARGETS: readonly BundleTarget[] = [
  {
    platform: "darwin",
    arch: "arm64",
    slug: "darwin-arm64",
    executableName: "atomic-agent",
    archiveExt: "tar.gz",
  },
  {
    platform: "darwin",
    arch: "x64",
    slug: "darwin-x64",
    executableName: "atomic-agent",
    archiveExt: "tar.gz",
  },
  {
    platform: "linux",
    arch: "x64",
    slug: "linux-x64",
    executableName: "atomic-agent",
    archiveExt: "tar.gz",
  },
  {
    platform: "linux",
    arch: "arm64",
    slug: "linux-arm64",
    executableName: "atomic-agent",
    archiveExt: "tar.gz",
  },
  {
    platform: "win32",
    arch: "x64",
    slug: "win32-x64",
    executableName: "atomic-agent.exe",
    archiveExt: "zip",
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
