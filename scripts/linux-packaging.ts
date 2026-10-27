/**
 * The Linux packages (deb, rpm, the AUR's atomic-agent-bin) and their apt/dnf
 * repository, the pure part: which release bundle goes into which package,
 * where a package puts the tree, the package and AUR versions, the PKGBUILD,
 * which releases the repository carries, its layout and the order it is
 * uploaded in. `linux-packages.ts` and `linux-repo.ts` do the file system and
 * the tools; this module has no I/O so `linux-packaging.test.ts` can cover it.
 *
 * A package carries the very bundle the release ships (`atomic-agent-<slug>.tar.gz`):
 * the SEA binary and the directories the runtime resolves next to it
 * (grammars, starter-skills, assets, vendor/rg, node_modules). Those cannot
 * go under /usr/bin, so the whole tree lives in INSTALL_DIR and /usr/bin holds
 * symlinks. Node resolves `process.execPath` through /proc/self/exe, so the
 * symlink is transparent to the runtime and no code knows about the layout
 * except `src/update/install-source.ts`, which reads the marker beside it.
 */
import { BUNDLE_TARGETS } from "./bundle-targets.js";

export const PACKAGE_NAME = "atomic-agent";
export const AUR_PACKAGE = "atomic-agent-bin";
export const GITHUB_REPO = "AtomicBot-ai/atomic-agent";
/** Where a package puts the bundle; `src/update/install-source.ts` agrees. */
export const INSTALL_DIR = "/usr/lib/atomic-agent";

export interface PackageTarget {
  /** The bundle slug (`scripts/bundle-targets.ts`). */
  slug: string;
  /** nfpm's name for the architecture (`arch:` in nfpm.yaml). */
  nfpm: string;
  /** Debian's name, in the deb file name. */
  deb: string;
  /** rpm's name, in the rpm file name. */
  rpm: string;
  /** pacman's `CARCH`, in the PKGBUILD's per-architecture arrays. */
  pacman: string;
  /** `process.arch` of the machine that can run this package's binary. */
  node: string;
}

/** One package per Linux bundle. */
export const PACKAGE_TARGETS: readonly PackageTarget[] = [
  { slug: "linux-x64", nfpm: "amd64", deb: "amd64", rpm: "x86_64", pacman: "x86_64", node: "x64" },
  { slug: "linux-arm64", nfpm: "arm64", deb: "arm64", rpm: "aarch64", pacman: "aarch64", node: "arm64" },
];

export const PACKAGE_FORMATS = ["deb", "rpm"] as const;
export type PackageFormat = (typeof PACKAGE_FORMATS)[number];

/**
 * Where the apt/dnf repository lives: a public bucket on Hetzner Object
 * Storage, served on its own HTTPS host. The bucket is this project's; the
 * signing key is shared with atc (eye-cli), see packaging/atomic-chat.asc.
 * README.md's install commands name the same URL (a test keeps them equal).
 */
export const REPOSITORY = {
  bucket: "atomic-agent-packages",
  region: "fsn1",
  endpoint: "https://fsn1.your-objectstorage.com",
  baseUrl: "https://atomic-agent-packages.fsn1.your-objectstorage.com",
} as const;

/** The published key's file names, in the bucket and in the README. */
export const KEY_FILE = "atomic-chat";

export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets?: Array<{ name: string }>;
}

export type SyncStep =
  | { op: "put"; path: string; cacheControl: string }
  | { op: "delete"; path: string };

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const PACKAGE_FILE = /^atomic-agent_.+\.(deb|rpm)$/;

/**
 * `atomic-agent_<version>_<arch>.<format>`: an underscore, so no
 * `atomic-agent-*` glob of the release workflow or the installer ever matches
 * a package.
 */
export function packageFileName(
  version: string,
  format: PackageFormat,
  target: PackageTarget,
): string {
  return `${PACKAGE_NAME}_${version}_${target[format]}.${format}`;
}

export function packageAssets(version: string): string[] {
  return PACKAGE_FORMATS.flatMap((format) =>
    PACKAGE_TARGETS.map((t) => packageFileName(version, format, t)),
  );
}

export function isPackageFile(name: string): boolean {
  return PACKAGE_FILE.test(name);
}

/** The release archive a package is built from, as `package-bundle.ts` names it. */
export function archiveAsset(target: PackageTarget): string {
  const bundle = BUNDLE_TARGETS.find((t) => t.slug === target.slug);
  if (!bundle) throw new Error(`${target.slug} is not a bundle target`);
  return `${PACKAGE_NAME}-${bundle.slug}.${bundle.archiveExt}`;
}

/** pacman's pkgver allows no hyphen: 0.3.0-rc.1 → 0.3.0rc.1 (still sorts before 0.3.0). */
export function archPkgver(version: string): string {
  return version.replace(/^v/, "").replaceAll("-", "");
}

/**
 * The oldest glibc an ELF file runs on: the highest GLIBC_x.y it requires,
 * from `readelf --version-info` (its .gnu.version_r). WEAK references are
 * optional and do not count. `undefined` for a file that references no
 * glibc version at all (a static binary such as ripgrep's musl build).
 */
export function glibcFloor(readelfVersions: string): string | undefined {
  const versions = [
    ...readelfVersions.matchAll(/Name: GLIBC_(\d+(?:\.\d+)+)\s+Flags: (\S+)/g),
  ]
    .filter((m) => !m[2]!.includes("WEAK"))
    .map((m) => m[1]!.split(".").map(Number));
  if (versions.length === 0) return undefined;
  return versions.reduce((max, v) => (newerVersion(v, max) ? v : max)).join(".");
}

/** The newest of several floors; `undefined` when none has one. */
export function maxGlibc(floors: readonly (string | undefined)[]): string | undefined {
  const known = floors.filter((f): f is string => f !== undefined);
  if (known.length === 0) return undefined;
  return known
    .map((f) => f.split(".").map(Number))
    .reduce((max, v) => (newerVersion(v, max) ? v : max))
    .join(".");
}

function newerVersion(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** A `<name>.sha256` file as `package-bundle.ts` writes it (`<hash>  <name>`) → the hash. */
export function parseSha256File(text: string, name: string): string {
  const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/m.exec(text.trim());
  if (!match || match[2] !== name) {
    throw new Error(`not a sha256 digest of ${name}: ${text.trim().slice(0, 80)}`);
  }
  return match[1]!.toLowerCase();
}

export interface PkgbuildValues {
  version: string;
  /** Download base of the release assets (the PKGBUILD's `_base`). */
  sourceBase: string;
  /** sha256 of each archive, by bundle slug. */
  sums: Record<string, string>;
}

/** packaging/PKGBUILD.in with this release's version, download base and checksums. */
export function renderPkgbuild(template: string, values: PkgbuildValues): string {
  const sum = (slug: string): string => {
    const hash = values.sums[slug];
    if (!hash) throw new Error(`no sha256 for the ${slug} archive`);
    return hash;
  };
  const [x64, arm64] = PACKAGE_TARGETS as [PackageTarget, PackageTarget];
  const fill: Record<string, string> = {
    VERSION: values.version,
    PKGVER: archPkgver(values.version),
    SOURCE_BASE: values.sourceBase,
    ARCHIVE_X86_64: archiveAsset(x64),
    ARCHIVE_AARCH64: archiveAsset(arm64),
    SLUG_X86_64: x64.slug,
    SLUG_AARCH64: arm64.slug,
    SHA_X86_64: sum(x64.slug),
    SHA_AARCH64: sum(arm64.slug),
  };
  // A Windows checkout has CRLF line ends; bash would read the \r as part of every line.
  return template.replace(/\r\n/g, "\n").replace(/@([A-Z0-9_]+)@/g, (match, key: string) => {
    const value = fill[key];
    if (value === undefined) throw new Error(`PKGBUILD.in has an unknown placeholder ${match}`);
    return value;
  });
}

function stableVersion(tag: string): number[] | undefined {
  const match = STABLE.exec(tag);
  return match ? match.slice(1).map(Number) : undefined;
}

/**
 * The releases the repository carries: the newest `keep` published, stable
 * releases that have packages (GitHub's release JSON). Drafts and
 * pre-releases never; releases from before the packages are skipped.
 */
export function selectReleases(
  releases: readonly GithubRelease[],
  keep = 10,
): Array<{ tag: string; version: string }> {
  return releases
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({ tag: r.tag_name, parts: stableVersion(r.tag_name), assets: r.assets ?? [] }))
    .filter((r): r is { tag: string; parts: number[]; assets: Array<{ name: string }> } =>
      r.parts !== undefined && r.assets.some((a) => PACKAGE_FILE.test(a.name)),
    )
    .sort((a, b) => (newerVersion(a.parts, b.parts) ? -1 : newerVersion(b.parts, a.parts) ? 1 : 0))
    .slice(0, keep)
    .map((r) => ({ tag: r.tag, version: r.parts.join(".") }));
}

/** Where a package file lives in the repository. */
export function repoPath(file: string): string {
  if (file.endsWith(".deb")) return `deb/pool/main/a/${PACKAGE_NAME}/${file}`;
  if (file.endsWith(".rpm")) return `rpm/packages/${file}`;
  throw new Error(`not a package: ${file}`);
}

/** The dnf repository definition users download into /etc/yum.repos.d. */
export function renderRepoFile(options: {
  baseUrl: string;
  packageSignatures?: boolean;
}): string {
  const packageSignatures = options.packageSignatures ?? true;
  return [
    `[${PACKAGE_NAME}]`,
    "name=Atomic Agent",
    `baseurl=${options.baseUrl}/rpm`,
    "enabled=1",
    `gpgcheck=${packageSignatures ? 1 : 0}`,
    "repo_gpgcheck=1",
    `gpgkey=${options.baseUrl}/${KEY_FILE}.asc`,
    "",
  ].join("\n");
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

/** Packages never change under a name; indexes and keys are checked on every request. */
export function cacheControl(path: string): string {
  return PACKAGE_FILE.test(path.split("/").pop() ?? "") ? IMMUTABLE : REVALIDATE;
}

const TYPES: Array<[RegExp, string]> = [
  [/\.deb$/, "application/vnd.debian.binary-package"],
  [/\.rpm$/, "application/x-rpm"],
  [/\.gz$/, "application/gzip"],
  [/\.xml$/, "application/xml"],
  [new RegExp(`(^|/)${KEY_FILE}\\.(asc|gpg)$`), "application/pgp-keys"],
  [/(Release\.gpg|\.asc)$/, "application/pgp-signature"],
];

export function contentType(path: string): string {
  return TYPES.find(([pattern]) => pattern.test(path))?.[1] ?? "text/plain; charset=utf-8";
}

/**
 * Upload order, so a client never sees an index that names a file not
 * uploaded yet: packages, then the indexes they are listed in, then what
 * points at those (Release, InRelease, repomd.xml and their signatures, the
 * keys, the .repo file).
 */
function rank(path: string): number {
  const name = path.split("/").pop() ?? "";
  if (PACKAGE_FILE.test(name)) return 0;
  if (/^(Packages(\.gz)?)$/.test(name)) return 1;
  if (path.startsWith("rpm/repodata/") && !name.startsWith("repomd.xml")) return 1;
  return 2;
}

/**
 * What to change in the bucket to make it `local`: upload new packages (an
 * uploaded one is identical, names are never reused), upload every index and
 * key, then delete what is no longer listed.
 */
export function syncPlan(local: readonly string[], remote: readonly string[]): SyncStep[] {
  const remoteSet = new Set(remote);
  const localSet = new Set(local);
  const puts: SyncStep[] = local
    .filter((p) => rank(p) > 0 || !remoteSet.has(p))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((path) => ({ op: "put", path, cacheControl: cacheControl(path) }));
  const deletes: SyncStep[] = remote
    .filter((p) => !localSet.has(p))
    .sort()
    .map((path) => ({ op: "delete", path }));
  return [...puts, ...deletes];
}

/** The shell lines of the README block marked `<!-- install:<name> -->`, the instructions users follow. */
export function readmeInstallBlock(readme: string, name: string): string {
  const text = readme.replace(/\r\n/g, "\n");
  const marker = `<!-- install:${name} -->`;
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`README.md has no ${marker}`);
  const match = /```(?:sh|bash)\n([\s\S]*?)```/.exec(text.slice(at));
  if (!match) throw new Error(`README.md has no sh block after ${marker}`);
  return match[1]!;
}
