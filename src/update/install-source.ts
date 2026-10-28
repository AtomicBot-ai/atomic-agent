import { readFileSync } from "node:fs";

/**
 * Who installed this atomic-agent.
 *
 * A Linux package (the deb, the rpm, the AUR's `atomic-agent-bin`) puts the
 * whole redistributable tree, the binary and the asset directories the
 * runtime resolves next to it, under {@link PACKAGE_DIR}, symlinks
 * `/usr/bin/atomic-agent` and `/usr/bin/atag` into it, and leaves a marker
 * naming the package format beside the binary. The package manager owns
 * those files and updates them with the rest of the system, so a self-update
 * must not rename over them: dpkg's or rpm's database would no longer match
 * the disk, and a non-root run would only fail on permissions halfway through.
 *
 * `process.execPath` is the resolved target of the `/usr/bin` symlink (Node
 * reads `/proc/self/exe`), which is why the test is against the real path
 * under `/usr/lib`. A copy installed anywhere else, the installer's
 * `~/.local/bin` say, stays the installer's even with a package on the same
 * machine.
 */
export const PACKAGE_DIR = "/usr/lib/atomic-agent";
export const PACKAGED_BINARY = `${PACKAGE_DIR}/atomic-agent`;
export const PACKAGE_MARKER = `${PACKAGE_DIR}/install-source`;

export const INSTALL_SOURCES = ["deb", "rpm", "aur"] as const;
export type InstallSource = (typeof INSTALL_SOURCES)[number];

const LABELS: Record<InstallSource, string> = {
  deb: "the deb package",
  rpm: "the rpm package",
  aur: "the AUR package atomic-agent-bin",
};

const UPGRADE: Record<InstallSource, string> = {
  deb: "sudo apt update && sudo apt install --only-upgrade atomic-agent",
  rpm: "sudo dnf upgrade atomic-agent",
  aur: "yay -Syu atomic-agent-bin (or your AUR helper)",
};

const REMOVE: Record<InstallSource, string> = {
  deb: "sudo apt remove atomic-agent",
  rpm: "sudo dnf remove atomic-agent",
  aur: "sudo pacman -R atomic-agent-bin",
};

/** Narrow the marker's text to a known source, else `undefined`. */
export function parseInstallSource(raw: unknown): InstallSource | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  return INSTALL_SOURCES.find((source) => source === value);
}

export interface ReadInstallSourceInput {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  /** Returns the file's text, or `undefined` when it cannot be read. */
  readonly readFile: (path: string) => string | undefined;
}

/**
 * The package that installed the binary at `execPath`, or `undefined` when no
 * package did. Pure apart from the injected read, so a test can run it for
 * any path on any host.
 */
export function readInstallSource(
  input: ReadInstallSourceInput,
): InstallSource | undefined {
  if (input.platform !== "linux" || input.execPath !== PACKAGED_BINARY) {
    return undefined;
  }
  return parseInstallSource(input.readFile(PACKAGE_MARKER));
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** {@link readInstallSource} for the running process. */
export function detectInstallSource(
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): InstallSource | undefined {
  return readInstallSource({ platform, execPath, readFile: readTextFile });
}

/**
 * The package installed on this machine while a binary from somewhere else
 * runs: an install.sh copy in `~/.local/bin`, say, which comes first on the
 * usual PATH. The two never write each other's files, so nothing is refused;
 * but a self-update of that copy leaves the package where it was and the
 * package manager's upgrade never reaches the copy, so the caller tells the
 * operator which one it is touching. `undefined` when there is no package or
 * when the packaged binary itself runs.
 */
export function readShadowedPackage(
  input: ReadInstallSourceInput,
): InstallSource | undefined {
  if (input.platform !== "linux" || input.execPath === PACKAGED_BINARY) {
    return undefined;
  }
  return parseInstallSource(input.readFile(PACKAGE_MARKER));
}

/** {@link readShadowedPackage} for the running process. */
export function detectShadowedPackage(
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): InstallSource | undefined {
  return readShadowedPackage({ platform, execPath, readFile: readTextFile });
}

export function installSourceLabel(source: InstallSource): string {
  return LABELS[source];
}

/** The command that updates a packaged atomic-agent. */
export function packageUpgradeHint(source: InstallSource): string {
  return UPGRADE[source];
}

/** The command that removes a packaged atomic-agent. */
export function packageRemoveHint(source: InstallSource): string {
  return REMOVE[source];
}

/**
 * Why a self-update is refused on a packaged install, and what to run
 * instead. One wording for the CLI, the TUI and the thrown error.
 */
export function packagedUpdateRefusal(source: InstallSource): string {
  return (
    `this atomic-agent was installed by ${installSourceLabel(source)}; ` +
    `update it with the package manager:\n  ${packageUpgradeHint(source)}`
  );
}

/**
 * What a self-update of a non-packaged copy does on a machine that also has
 * the package ({@link readShadowedPackage}): names both so the operator can
 * tell which copy they keep.
 */
export function shadowedPackageNotice(
  source: InstallSource,
  execPath: string,
): string {
  const dir = execPath.slice(0, execPath.lastIndexOf("/")) || "/";
  return (
    `note: ${installSourceLabel(source)} also installed atomic-agent ` +
    `(/usr/bin/atomic-agent); this updates only ${execPath}, which runs ` +
    `because ${dir} comes first on PATH. To run the package's copy instead, ` +
    `remove ${dir}/atomic-agent and ${dir}/atag.`
  );
}
