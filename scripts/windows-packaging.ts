/**
 * Windows package managers, the pure part: the Scoop manifest of the CLI and
 * the winget manifests of the CLI and the desktop app, rendered from a
 * release's checksums. `windows-packages.ts` reads the files and writes them;
 * `.github/workflows/windows-packages.yml` ships them when a release is
 * published. No I/O here, so `windows-packaging.test.ts` can cover it.
 *
 *   scoop bucket add atomicbot https://github.com/AtomicBot-ai/scoop-bucket
 *   scoop install atomicbot/atomic-agent          # CLI: atomic-agent and atag
 *   winget install AtomicBot.AtomicAgent          # desktop app
 *   winget install AtomicBot.AtomicAgent.CLI      # CLI: atomic-agent
 *
 * Both CLI packages unpack the release's `atomic-agent-win32-x64.zip` (the
 * archive install.ps1 fetches) as a whole, because the runtime resolves
 * grammars\, vendor\, starter-skills\ and node_modules\ next to
 * `process.execPath`. For the same reason the winget CLI package sets
 * `ArchiveBinariesDependOnPath`: winget then puts the unpacked folder on PATH
 * instead of a symlink to the exe in its Links folder, which would leave the
 * exe looking for those folders beside the link. Scoop's shims start the real
 * exe, so Scoop can add the `atag` alias; winget cannot without a symlink.
 *
 * The desktop app is in winget only: its NSIS installer is what winget runs
 * natively, while Scoop would have to unpack the installer by hand and fight
 * the app's own updater.
 */

export const GITHUB_REPO = "AtomicBot-ai/atomic-agent";
export const SCOOP_BUCKET_REPO = "AtomicBot-ai/scoop-bucket";
export const SCOOP_MANIFEST_PATH = "bucket/atomic-agent.json";
export const WINGET_DESKTOP_ID = "AtomicBot.AtomicAgent";
export const WINGET_CLI_ID = "AtomicBot.AtomicAgent.CLI";
export const WINGET_MANIFEST_VERSION = "1.6.0";
export const CLI_ZIP = "atomic-agent-win32-x64.zip";

const HOMEPAGE = "https://atomicagent.io";
const PUBLISHER = "Atomic Bot";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type Product = "cli" | "desktop";
export type WinArch = "x64" | "arm64";

/** Product and version of a stable release tag, or `undefined` (pre-releases included). */
export function parseReleaseTag(tag: string): { product: Product; version: string } | undefined {
  const desktop = /^desktop-v(.+)$/.exec(tag);
  if (desktop) {
    return SEMVER.test(desktop[1]!) ? { product: "desktop", version: desktop[1]! } : undefined;
  }
  const cli = /^v(.+)$/.exec(tag);
  if (cli) return SEMVER.test(cli[1]!) ? { product: "cli", version: cli[1]! } : undefined;
  return undefined;
}

export function releaseTag(product: Product, version: string): string {
  return product === "cli" ? `v${version}` : `desktop-v${version}`;
}

export function releaseUrl(tag: string, file: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${file}`;
}

/** The desktop's NSIS installer (desktop/electron-builder.cjs, `win.artifactName`). */
export function desktopInstaller(version: string, arch: WinArch): string {
  return `Atomic-Agent-Setup-${version}-${arch}.exe`;
}

/** The hash of one `shasum -a 256` line (`<hash>  <name>`). */
export function parseDigestFile(text: string): string {
  const hash = text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (!SHA256.test(hash)) throw new Error(`not a sha256 digest line: ${JSON.stringify(text)}`);
  return hash;
}

/** `SHA256SUMS.txt` as file name → hash. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

function checkVersion(version: string): void {
  if (!SEMVER.test(version)) throw new Error(`not a release version: ${version}`);
}

function checkHash(hash: string | undefined, what: string): string {
  if (!hash || !SHA256.test(hash)) throw new Error(`missing or bad sha256 for ${what}`);
  return hash;
}

/**
 * The Scoop manifest of the CLI. `checkver` reads the releases feed for the
 * newest `vX.Y.Z` tag (the repository's "latest" release can be a desktop
 * one), and `autoupdate` takes the hash from the `.sha256` file the release
 * publishes, so the bucket's own tooling can update it too.
 */
export function renderScoopManifest(version: string, zipSha256: string): string {
  checkVersion(version);
  const manifest = {
    version,
    description: "Local-first AI agent for the terminal (Atomic Agent CLI)",
    homepage: HOMEPAGE,
    license: "MIT",
    notes: "Run atag (or atomic-agent). Data lives in ~\\.atomic-agent, shared with the desktop app.",
    architecture: {
      "64bit": {
        url: releaseUrl(`v${version}`, CLI_ZIP),
        hash: checkHash(zipSha256, CLI_ZIP),
      },
    },
    bin: ["atomic-agent.exe", ["atomic-agent.exe", "atag"]],
    checkver: {
      url: `https://github.com/${GITHUB_REPO}/releases.atom`,
      regex: "releases/tag/v([\\d.]+)\"",
    },
    autoupdate: {
      architecture: {
        "64bit": {
          url: `https://github.com/${GITHUB_REPO}/releases/download/v$version/${CLI_ZIP}`,
          hash: { url: "$url.sha256" },
        },
      },
    },
  };
  return `${JSON.stringify(manifest, null, 4)}\n`;
}

export interface WingetInstaller {
  arch: WinArch;
  url: string;
  sha256: string;
}

/** One manifest file of a winget package version: its path under the repo and its text. */
export interface WingetFile {
  path: string;
  text: string;
}

/** `manifests/<first letter>/<Publisher>/<Name…>/<version>` as winget-pkgs lays it out. */
export function wingetManifestDir(id: string, version: string): string {
  const parts = id.split(".");
  return ["manifests", id[0]!.toLowerCase(), ...parts, version].join("/");
}

function header(kind: string): string {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${kind}.${WINGET_MANIFEST_VERSION}.schema.json\n`;
}

/** A YAML scalar, double-quoted so no value is read as anything but a string. */
function q(value: string): string {
  return JSON.stringify(value);
}

function installerFile(
  id: string,
  version: string,
  body: string[],
  installers: readonly WingetInstaller[],
): string {
  if (installers.length === 0) throw new Error(`${id}: no installers`);
  const lines = [
    `PackageIdentifier: ${id}`,
    `PackageVersion: ${q(version)}`,
    ...body,
    "Installers:",
  ];
  for (const installer of installers) {
    lines.push(
      `- Architecture: ${installer.arch}`,
      `  InstallerUrl: ${q(installer.url)}`,
      `  InstallerSha256: ${checkHash(installer.sha256, installer.url).toUpperCase()}`,
    );
  }
  lines.push("ManifestType: installer", `ManifestVersion: ${WINGET_MANIFEST_VERSION}`, "");
  return header("installer") + lines.join("\n");
}

function localeFile(
  id: string,
  version: string,
  fields: { name: string; moniker: string; short: string; tag: string },
): string {
  const lines = [
    `PackageIdentifier: ${id}`,
    `PackageVersion: ${q(version)}`,
    "PackageLocale: en-US",
    `Publisher: ${q(PUBLISHER)}`,
    `PublisherUrl: ${q(HOMEPAGE)}`,
    `PublisherSupportUrl: ${q(`https://github.com/${GITHUB_REPO}/issues`)}`,
    `PackageName: ${q(fields.name)}`,
    `PackageUrl: ${q(HOMEPAGE)}`,
    "License: MIT",
    `LicenseUrl: ${q(`https://github.com/${GITHUB_REPO}/blob/main/LICENSE`)}`,
    `ShortDescription: ${q(fields.short)}`,
    `Moniker: ${fields.moniker}`,
    "Tags:",
    "- ai",
    "- agent",
    "- llm",
    "- local-ai",
    "- llama-cpp",
    `ReleaseNotesUrl: ${q(`https://github.com/${GITHUB_REPO}/releases/tag/${fields.tag}`)}`,
    "ManifestType: defaultLocale",
    `ManifestVersion: ${WINGET_MANIFEST_VERSION}`,
    "",
  ];
  return header("defaultLocale") + lines.join("\n");
}

function versionFile(id: string, version: string): string {
  return (
    header("version") +
    [
      `PackageIdentifier: ${id}`,
      `PackageVersion: ${q(version)}`,
      "DefaultLocale: en-US",
      "ManifestType: version",
      `ManifestVersion: ${WINGET_MANIFEST_VERSION}`,
      "",
    ].join("\n")
  );
}

function files(id: string, version: string, installer: string, locale: string): WingetFile[] {
  const dir = wingetManifestDir(id, version);
  return [
    { path: `${dir}/${id}.yaml`, text: versionFile(id, version) },
    { path: `${dir}/${id}.installer.yaml`, text: installer },
    { path: `${dir}/${id}.locale.en-US.yaml`, text: locale },
  ];
}

/** winget manifests of the CLI: the release zip, unpacked and put on PATH. */
export function renderWingetCli(version: string, zipSha256: string): WingetFile[] {
  checkVersion(version);
  const tag = `v${version}`;
  const installer = installerFile(
    WINGET_CLI_ID,
    version,
    [
      "InstallerType: zip",
      "NestedInstallerType: portable",
      "NestedInstallerFiles:",
      "- RelativeFilePath: atomic-agent.exe",
      // PATH, not a symlink: the exe finds its folders next to itself.
      "ArchiveBinariesDependOnPath: true",
      "Commands:",
      "- atomic-agent",
      "UpgradeBehavior: install",
    ],
    [{ arch: "x64", url: releaseUrl(tag, CLI_ZIP), sha256: zipSha256 }],
  );
  const locale = localeFile(WINGET_CLI_ID, version, {
    name: "Atomic Agent CLI",
    moniker: "atomic-agent",
    short: "Local-first AI agent for the terminal",
    tag,
  });
  return files(WINGET_CLI_ID, version, installer, locale);
}

/** winget manifests of the desktop app: its per-user NSIS installers. */
export function renderWingetDesktop(
  version: string,
  digests: Partial<Record<WinArch, string>>,
): WingetFile[] {
  checkVersion(version);
  const tag = `desktop-v${version}`;
  const arches: WinArch[] = ["x64", "arm64"];
  const installers = arches
    .filter((arch) => digests[arch] !== undefined)
    .map((arch) => ({
      arch,
      url: releaseUrl(tag, desktopInstaller(version, arch)),
      sha256: digests[arch]!,
    }));
  const installer = installerFile(
    WINGET_DESKTOP_ID,
    version,
    [
      // nullsoft: winget passes /S for a silent install.
      "InstallerType: nullsoft",
      // desktop/electron-builder.cjs: nsis.perMachine false.
      "Scope: user",
      "UpgradeBehavior: install",
    ],
    installers,
  );
  const locale = localeFile(WINGET_DESKTOP_ID, version, {
    name: "Atomic Agent",
    moniker: "atomic-agent-desktop",
    short: "Local-first AI agent desktop app",
    tag,
  });
  return files(WINGET_DESKTOP_ID, version, installer, locale);
}

/**
 * `wingetcreate update` arguments for a package already in winget-pkgs:
 * `<id> --version <v> --urls <url>|<arch> …`. The token and `--submit` are
 * added by the workflow.
 */
export function wingetUpdateArgs(id: string, version: string, installers: readonly WingetInstaller[]): string[] {
  checkVersion(version);
  if (installers.length === 0) throw new Error(`${id}: no installers`);
  return [
    "update",
    id,
    "--version",
    version,
    "--urls",
    ...installers.map((installer) => `${installer.url}|${installer.arch}`),
  ];
}
