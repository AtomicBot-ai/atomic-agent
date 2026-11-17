/**
 * The Homebrew tap (`AtomicBot-ai/homebrew-tap`), the pure part: the formula
 * `atag` for the CLI and the cask `atomic-agent` for the desktop app, rendered
 * from a release's checksums. `homebrew.ts` reads the files and writes the
 * Ruby; `.github/workflows/homebrew.yml` commits it to the tap when a release
 * is published. No I/O here, so `homebrew-packaging.test.ts` can cover it.
 *
 *   brew install atomicbot-ai/tap/atag                 # CLI, commands atag and atomic-agent
 *   brew install --cask atomicbot-ai/tap/atomic-agent  # desktop app
 *
 * The formula installs the release bundle (`atomic-agent-darwin-<arch>.tar.gz`,
 * the very archive install.sh fetches) whole under `libexec`, because the
 * runtime resolves grammars/, vendor/, starter-skills/ and node_modules/ next
 * to `process.execPath`, and links `bin/atag` and `bin/atomic-agent` to it
 * (Node resolves the symlink on macOS, as with install.sh's `atag`). It is
 * macOS only: Linux has the deb, rpm and AUR packages, and Homebrew on Linux
 * would run a prebuilt ELF against its own glibc.
 *
 * Both are generated whole on every release instead of bumped in place
 * (bump-homebrew-formula-action edits one url and one sha256), because each
 * carries one url per architecture and the Intel builds may come and go.
 */

export const GITHUB_REPO = "AtomicBot-ai/atomic-agent";
export const TAP_REPO = "AtomicBot-ai/homebrew-tap";
export const FORMULA_NAME = "atag";
export const CASK_NAME = "atomic-agent";
export const FORMULA_PATH = `Formula/${FORMULA_NAME}.rb`;
export const CASK_PATH = `Casks/${CASK_NAME}.rb`;
const HOMEPAGE = "https://atomicagent.io";

export type MacArch = "arm64" | "x64";
/** Homebrew's names for the two Mac architectures, in the order the files list them. */
const ON: Record<MacArch, "on_arm" | "on_intel"> = { arm64: "on_arm", x64: "on_intel" };
const ARCHES: readonly MacArch[] = ["arm64", "x64"];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type Product = "cli" | "desktop";

/**
 * Which product a release tag is and its version, or `undefined` for a tag of
 * neither or a pre-release (Homebrew carries stable versions only).
 */
export function parseReleaseTag(tag: string): { product: Product; version: string } | undefined {
  const desktop = /^desktop-v(.+)$/.exec(tag);
  if (desktop) {
    return SEMVER.test(desktop[1]!) ? { product: "desktop", version: desktop[1]! } : undefined;
  }
  const cli = /^v(.+)$/.exec(tag);
  if (cli) return SEMVER.test(cli[1]!) ? { product: "cli", version: cli[1]! } : undefined;
  return undefined;
}

/** The CLI release bundle of a Mac architecture (scripts/package-bundle.ts). */
export function cliArchive(arch: MacArch): string {
  return `atomic-agent-darwin-${arch}.tar.gz`;
}

/** The desktop DMG of a Mac architecture (desktop/electron-builder.cjs, `dmg.artifactName`). */
export function desktopDmg(version: string, arch: MacArch): string {
  return `Atomic-Agent-${version}-${arch}.dmg`;
}

/** The hash of one `shasum -a 256` line (`<hash>  <name>`). */
export function parseDigestFile(text: string): string {
  const hash = text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (!SHA256.test(hash)) throw new Error(`not a sha256 digest line: ${JSON.stringify(text)}`);
  return hash;
}

/** `SHA256SUMS.txt` (the desktop release's) as file name → hash. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

export type ArchDigests = Partial<Record<MacArch, string>>;

function requireDigests(digests: ArchDigests, what: string): MacArch[] {
  const present = ARCHES.filter((arch) => digests[arch] !== undefined);
  if (present.length === 0) throw new Error(`no macOS ${what} in the release`);
  for (const arch of present) {
    if (!SHA256.test(digests[arch]!)) throw new Error(`bad sha256 for ${arch}: ${digests[arch]}`);
  }
  return present;
}

function releaseUrl(tag: string, file: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${file}`;
}

/** The formula `atag` for CLI release `version`. */
export function renderFormula(version: string, digests: ArchDigests): string {
  if (!SEMVER.test(version)) throw new Error(`not a release version: ${version}`);
  const arches = requireDigests(digests, "CLI bundle");
  const tag = `v${version}`;
  const lines = [
    `# Generated from the ${tag} release of ${GITHUB_REPO} by scripts/homebrew.ts.`,
    "# Do not edit here: the next release overwrites it.",
    "class Atag < Formula",
    '  desc "Local-first AI agent for the terminal (Atomic Agent CLI)"',
    `  homepage "${HOMEPAGE}"`,
    `  version "${version}"`,
    '  license "MIT"',
    "",
    // github_releases with the CLI's tag shape: the repository's "latest"
    // release can be a desktop-v one, which github_latest would read.
    "  livecheck do",
    "    url :stable",
    "    regex(/^v(\\d+(?:\\.\\d+)+)$/i)",
    "    strategy :github_releases",
    "  end",
    "",
    "  depends_on :macos",
    ...(arches.length === 1 && arches[0] === "arm64" ? ["  depends_on arch: :arm64"] : []),
    ...(arches.length === 1 && arches[0] === "x64" ? ["  depends_on arch: :x86_64"] : []),
    "",
  ];
  for (const arch of arches) {
    lines.push(
      `  ${ON[arch]} do`,
      `    url "${releaseUrl(tag, cliArchive(arch))}"`,
      `    sha256 "${digests[arch]}"`,
      "  end",
      "",
    );
  }
  lines.push(
    "  def install",
    "    # The binary finds grammars/, vendor/, starter-skills/ and node_modules/",
    "    # next to itself, so the bundle stays together under libexec.",
    '    libexec.install Dir["*"]',
    '    bin.install_symlink libexec/"atomic-agent"',
    '    bin.install_symlink libexec/"atomic-agent" => "atag"',
    "  end",
    "",
    "  test do",
    '    assert_match version.to_s, shell_output("#{bin}/atag --version")',
    "  end",
    "end",
    "",
  );
  return lines.join("\n");
}

/** The cask `atomic-agent` for desktop release `version`. */
export function renderCask(version: string, digests: ArchDigests): string {
  if (!SEMVER.test(version)) throw new Error(`not a release version: ${version}`);
  const arches = requireDigests(digests, "DMG");
  const both = arches.length === 2;
  const only = arches[0]!;
  const lines = [
    `# Generated from the desktop-v${version} release of ${GITHUB_REPO} by scripts/homebrew.ts.`,
    "# Do not edit here: the next desktop release overwrites it.",
    `cask "${CASK_NAME}" do`,
  ];
  if (both) {
    lines.push(
      '  arch arm: "arm64", intel: "x64"',
      "",
      `  version "${version}"`,
      `  sha256 arm:   "${digests.arm64}",`,
      `         intel: "${digests.x64}"`,
      "",
      `  url "https://github.com/${GITHUB_REPO}/releases/download/desktop-v#{version}/Atomic-Agent-#{version}-#{arch}.dmg",`,
    );
  } else {
    lines.push(
      `  version "${version}"`,
      `  sha256 "${digests[only]}"`,
      "",
      `  url "https://github.com/${GITHUB_REPO}/releases/download/desktop-v#{version}/Atomic-Agent-#{version}-${only}.dmg",`,
    );
  }
  lines.push(
    `      verified: "github.com/${GITHUB_REPO}/"`,
    '  name "Atomic Agent"',
    '  desc "Local-first AI agent desktop app"',
    `  homepage "${HOMEPAGE}"`,
    "",
    "  livecheck do",
    "    url :url",
    "    regex(/^desktop-v(\\d+(?:\\.\\d+)+)$/i)",
    "    strategy :github_releases",
    "  end",
    "",
    // The app updates itself (electron-updater, the same desktop-latest feed);
    // brew upgrade leaves it alone unless --greedy.
    "  auto_updates true",
    ...(both ? [] : [`  depends_on arch: ${only === "arm64" ? ":arm64" : ":x86_64"}`]),
    "",
    '  app "Atomic Agent.app"',
    "",
    "  # ~/.atomic-agent is shared with the CLI (atag), so zap leaves it alone.",
    "  zap trash: [",
    '    "~/Library/Application Support/Atomic Agent",',
    '    "~/Library/Caches/atomic-agent-desktop-updater",',
    '    "~/Library/Caches/io.atomicagent.desktop",',
    '    "~/Library/Caches/io.atomicagent.desktop.ShipIt",',
    '    "~/Library/HTTPStorages/io.atomicagent.desktop",',
    '    "~/Library/Logs/Atomic Agent",',
    '    "~/Library/Preferences/io.atomicagent.desktop.plist",',
    '    "~/Library/Saved Application State/io.atomicagent.desktop.savedState",',
    "  ]",
    "end",
    "",
  );
  return lines.join("\n");
}

/** The `version "…"` a rendered formula or cask carries, or `undefined`. */
export function renderedVersion(ruby: string): string | undefined {
  return /^\s*version "([^"]+)"/m.exec(ruby)?.[1];
}

/** -1, 0 or 1 for two X.Y.Z versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
