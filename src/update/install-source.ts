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
 *
 * npm, Homebrew, Scoop and winget own their copy the same way: their upgrade
 * replaces it and their uninstall removes it, so a self-update would only be
 * undone (or fight the manager's own bookkeeping). They leave no marker; the
 * binary's path says which one installed it ({@link managerForPath}).
 */
export const PACKAGE_DIR = "/usr/lib/atomic-agent";
export const PACKAGED_BINARY = `${PACKAGE_DIR}/atomic-agent`;
export const PACKAGE_MARKER = `${PACKAGE_DIR}/install-source`;

/** The Linux packages, which leave the marker under {@link PACKAGE_DIR}. */
export const LINUX_PACKAGE_SOURCES = ["deb", "rpm", "aur"] as const;

/**
 * The package managers outside Linux, recognised by where they put the
 * binary (no marker: none of them runs a script of ours at install time
 * that every one of them would honour). See {@link MANAGED_PATHS}.
 */
export const MANAGER_SOURCES = ["npm", "homebrew", "scoop", "winget"] as const;

export const INSTALL_SOURCES = [...LINUX_PACKAGE_SOURCES, ...MANAGER_SOURCES] as const;
export type InstallSource = (typeof INSTALL_SOURCES)[number];
type ManagerSource = (typeof MANAGER_SOURCES)[number];

const LABELS: Record<InstallSource, string> = {
  deb: "the deb package",
  rpm: "the rpm package",
  aur: "the AUR package atomic-agent-bin",
  npm: "npm (the atomic-agent package)",
  homebrew: "Homebrew (the atag formula)",
  scoop: "Scoop (the atomic-agent manifest)",
  winget: "winget (AtomicBot.AtomicAgent.CLI)",
};

const UPGRADE: Record<InstallSource, string> = {
  deb: "sudo apt update && sudo apt install --only-upgrade atomic-agent",
  rpm: "sudo dnf upgrade atomic-agent",
  aur: "yay -Syu atomic-agent-bin (or your AUR helper)",
  npm: "npm install -g atomic-agent@latest",
  homebrew: "brew update && brew upgrade atag",
  scoop: "scoop update atomic-agent",
  winget: "winget upgrade AtomicBot.AtomicAgent.CLI",
};

const REMOVE: Record<InstallSource, string> = {
  deb: "sudo apt remove atomic-agent",
  rpm: "sudo dnf remove atomic-agent",
  aur: "sudo pacman -R atomic-agent-bin",
  npm: "npm uninstall -g atomic-agent",
  homebrew: "brew uninstall atag",
  scoop: "scoop uninstall atomic-agent",
  winget: "winget uninstall AtomicBot.AtomicAgent.CLI",
};

/**
 * Where each package manager keeps the binary, as `process.execPath` sees it
 * (the resolved path: Node resolves the `bin` symlink on macOS and Linux, and
 * a Scoop shim starts the real exe). Matched against the path with `\` turned
 * into `/`, case-insensitively on Windows. Every pattern names our own
 * package, so a binary of the same name from anywhere else never matches:
 *
 *   npm      <prefix>/node_modules/@atomicbot/atag-<slug>/atomic-agent[.exe]
 *            (the launcher package's platform dependency; packaging/npm)
 *   homebrew <prefix>/Cellar/atag/<version>/libexec/atomic-agent
 *   scoop    <root>/apps/atomic-agent/<version|current>/atomic-agent.exe
 *   winget   .../WinGet/Packages/AtomicBot.AtomicAgent.CLI_<source>/atomic-agent.exe,
 *            or its alias under .../WinGet/Links/
 */
const MANAGED_PATHS: ReadonlyArray<{
  source: ManagerSource;
  platforms: readonly NodeJS.Platform[];
  pattern: RegExp;
}> = [
  {
    source: "npm",
    platforms: ["darwin", "linux", "win32"],
    pattern: /\/node_modules\/@atomicbot\/atag-[a-z0-9-]+\/atomic-agent(\.exe)?$/i,
  },
  {
    source: "homebrew",
    platforms: ["darwin", "linux"],
    pattern: /\/Cellar\/atag\/[^/]+\/libexec\/atomic-agent$/,
  },
  {
    source: "scoop",
    platforms: ["win32"],
    pattern: /\/apps\/atomic-agent\/[^/]+\/atomic-agent\.exe$/i,
  },
  {
    source: "winget",
    platforms: ["win32"],
    pattern:
      /\/winget\/(packages\/atomicbot\.atomicagent\.cli_[^/]+\/atomic-agent|links\/(atomic-agent|atag))\.exe$/i,
  },
];

/** The package manager whose layout `execPath` sits in, if any. */
export function managerForPath(
  platform: NodeJS.Platform,
  execPath: string,
): ManagerSource | undefined {
  const path = platform === "win32" ? execPath.replace(/\\/g, "/") : execPath;
  return MANAGED_PATHS.find(
    (entry) => entry.platforms.includes(platform) && entry.pattern.test(path),
  )?.source;
}

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
  const managed = managerForPath(input.platform, input.execPath);
  if (managed) return managed;
  if (input.platform !== "linux" || input.execPath !== PACKAGED_BINARY) {
    return undefined;
  }
  return parseLinuxPackageSource(input.readFile(PACKAGE_MARKER));
}

/** The marker names a Linux package only; a manager is known by its path. */
function parseLinuxPackageSource(raw: unknown): InstallSource | undefined {
  const source = parseInstallSource(raw);
  return (LINUX_PACKAGE_SOURCES as readonly string[]).includes(source ?? "")
    ? source
    : undefined;
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
  return parseLinuxPackageSource(input.readFile(PACKAGE_MARKER));
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
