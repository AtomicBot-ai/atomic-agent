/**
 * ATO-1203: the folders CLI installers put binaries in, added to the end of
 * the agent's PATH.
 *
 * An app opened from Finder or the Dock does not run a login shell, so it
 * gets launchd's short PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), and so does
 * every `atag` it spawns. A Claude Code or Codex CLI the person runs fine in
 * Terminal (native installer: `~/.local/bin`; Homebrew: `/opt/homebrew/bin`
 * or `/usr/local/bin`; npm/bun/volta globals) then reads as "not installed"
 * to the agent, and a subscription provider saved without a `binPath`
 * (before ATO-756, or by the terminal wizard) cannot answer.
 *
 * Only appended, and only folders not already on PATH, so nothing the person
 * set up is shadowed: a PATH that already finds the CLI finds the same one.
 * macOS and Linux only; Windows apps get the user's full PATH.
 *
 * Pure (no fs, no process) so it can be unit-tested against the built output
 * (test/installer-path.test.mjs).
 */

/** The folders, in the order they are appended. */
export function installerBinDirs(home: string): string[] {
  const h = home.replace(/\/+$/, "");
  return [
    `${h}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${h}/.npm-global/bin`,
    `${h}/.bun/bin`,
    `${h}/.volta/bin`,
  ];
}

/**
 * `path` with the installer folders appended that it does not hold yet.
 * Unchanged on Windows, and when `home` is not an absolute path.
 */
export function withInstallerBinDirs(path: string | undefined, platform: NodeJS.Platform, home: string): string | undefined {
  if (platform !== "darwin" && platform !== "linux") return path;
  if (typeof home !== "string" || !home.startsWith("/")) return path;
  const have = (path ?? "").split(":").filter((d) => d.length > 0);
  const seen = new Set(have.map((d) => d.replace(/\/+$/, "")));
  const add = installerBinDirs(home).filter((d) => !seen.has(d));
  if (add.length === 0) return path;
  return [...have, ...add].join(":");
}
