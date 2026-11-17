// Which platform package carries the binary for this machine. Kept free of
// I/O so the repository's tests can import it (scripts/npm-packaging.test.ts
// checks it against scripts/bundle-targets.ts, the release matrix).

/** npm scope of the platform packages. */
export const SCOPE = "@atomicbot";

/** `<platform>-<arch>` slugs the release builds, as in scripts/bundle-targets.ts. */
export const SLUGS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];

/** The platform package for a release slug, e.g. `@atomicbot/atag-darwin-arm64`. */
export function platformPackageName(slug) {
  return `${SCOPE}/atag-${slug}`;
}

/** The binary's file name inside a platform package. */
export function executableName(platform) {
  return platform === "win32" ? "atomic-agent.exe" : "atomic-agent";
}

/**
 * The slug for a Node `process.platform` / `process.arch` pair, or
 * `undefined` when no release is built for it.
 */
export function slugFor(platform, arch) {
  const slug = `${platform}-${arch}`;
  return SLUGS.includes(slug) ? slug : undefined;
}
