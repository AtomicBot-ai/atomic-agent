import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BUNDLE_TARGETS } from "./bundle-targets.js";
import {
  archiveAsset,
  archPkgver,
  cacheControl,
  contentType,
  desktopPackageFileName,
  glibcFloor,
  INSTALL_DIR,
  isPackageFile,
  maxGlibc,
  PACKAGE_TARGETS,
  packageAssets,
  parseProductId,
  parseSha256File,
  parseSha256Sums,
  productOfFile,
  productOfTag,
  PRODUCTS,
  readmeInstallBlock,
  renderPkgbuild,
  renderRepoFile,
  REPOSITORY,
  repoPath,
  selectReleases,
  syncPlan,
  type GithubRelease,
} from "./linux-packaging.js";

describe("package assets", () => {
  it("names one deb and one rpm per architecture, none matching the bundles' atomic-agent-* glob", () => {
    const names = packageAssets("0.7.0");
    expect(names).toEqual([
      "atomic-agent_0.7.0_amd64.deb",
      "atomic-agent_0.7.0_arm64.deb",
      "atomic-agent_0.7.0_x86_64.rpm",
      "atomic-agent_0.7.0_aarch64.rpm",
    ]);
    for (const name of names) {
      expect(name.startsWith("atomic-agent-")).toBe(false);
      expect(isPackageFile(name)).toBe(true);
    }
    expect(isPackageFile("atomic-agent_0.7.0_amd64.deb.sha256")).toBe(false);
    expect(isPackageFile("atomic-agent-linux-x64.tar.gz")).toBe(false);
  });

  it("knows the desktop's packages by electron-builder's names, and nothing else of that release", () => {
    const [x64, arm64] = PACKAGE_TARGETS as [(typeof PACKAGE_TARGETS)[number], (typeof PACKAGE_TARGETS)[number]];
    expect(desktopPackageFileName("0.0.6", "deb", x64)).toBe("Atomic-Agent-0.0.6-amd64.deb");
    expect(desktopPackageFileName("0.0.6", "deb", arm64)).toBe("Atomic-Agent-0.0.6-arm64.deb");
    expect(desktopPackageFileName("0.0.6", "rpm", x64)).toBe("Atomic-Agent-0.0.6-x86_64.rpm");
    for (const name of [
      "Atomic-Agent-0.0.6-amd64.deb",
      "Atomic-Agent-0.0.6-arm64.deb",
      "Atomic-Agent-0.0.6-x86_64.rpm",
      "Atomic-Agent-0.0.6-aarch64.rpm",
    ]) {
      expect(productOfFile(name)?.id).toBe("desktop");
    }
    for (const name of [
      "Atomic-Agent-0.0.6-x86_64.AppImage",
      "Atomic-Agent-0.0.6-arm64.dmg",
      "Atomic-Agent-Setup-0.0.6-x64.exe",
      "SHA256SUMS.txt",
      "stable-linux.yml",
    ]) {
      expect(productOfFile(name)).toBeUndefined();
    }
    expect(productOfFile("atomic-agent_0.7.0_amd64.deb")?.id).toBe("cli");
  });

  it("maps release tags to products and plain versions", () => {
    expect(productOfTag("v0.7.0")).toEqual({ product: PRODUCTS.cli, version: "0.7.0" });
    expect(productOfTag("desktop-v0.0.6")).toEqual({ product: PRODUCTS.desktop, version: "0.0.6" });
    expect(productOfTag("desktop-latest")).toBeUndefined();
    expect(productOfTag("v0.7.0-rc.1")).toBeUndefined();
    expect(productOfTag("0.7.0")).toBeUndefined();
    expect(parseProductId("desktop")).toBe("desktop");
    expect(() => parseProductId("snap")).toThrow("unknown product snap");
  });

  it("packages the Linux bundle targets and nothing else", () => {
    const linux = BUNDLE_TARGETS.filter((t) => t.platform === "linux").map((t) => t.slug);
    expect(PACKAGE_TARGETS.map((t) => t.slug)).toEqual(linux);
    expect(archiveAsset(PACKAGE_TARGETS[0]!)).toBe("atomic-agent-linux-x64.tar.gz");
    expect(archiveAsset(PACKAGE_TARGETS[1]!)).toBe("atomic-agent-linux-arm64.tar.gz");
  });

  it("puts the tree where src/update/install-source.ts expects it", () => {
    const source = readFileSync("src/update/install-source.ts", "utf8");
    expect(source).toContain(`PACKAGE_DIR = "${INSTALL_DIR}"`);
    const nfpm = readFileSync("packaging/nfpm.yaml", "utf8");
    expect(nfpm).toContain(`dst: ${INSTALL_DIR}\n`);
    expect(nfpm).toContain(`dst: ${INSTALL_DIR}/install-source`);
    const pkgbuild = readFileSync("packaging/PKGBUILD.in", "utf8");
    expect(pkgbuild).toContain(`"\${pkgdir}${INSTALL_DIR}"`);
  });
});

describe("glibcFloor", () => {
  // readelf -V of a Node 25 Linux build (abridged).
  const readelf = [
    "Version needs section '.gnu.version_r' contains 2 entries:",
    "  0x0000: Version: 1  File: libc.so.6  Cnt: 12",
    "  0x0010:   Name: GLIBC_2.2.5  Flags: none  Version: 2",
    "  0x0130:   Name: GLIBC_2.18  Flags: none  Version: 23",
    "  0x0140:   Name: GLIBC_2.28  Flags: none  Version: 8",
    "  0x0150:   Name: GLIBC_2.25  Flags: none  Version: 22",
    "  0x0160:   Name: GLIBC_2.34  Flags: WEAK  Version: 24",
  ].join("\n");

  it("is the newest required version, compared as numbers, ignoring WEAK ones", () => {
    expect(glibcFloor(readelf)).toBe("2.28");
  });

  it("is undefined for a static binary", () => {
    expect(glibcFloor("There are no version dependencies in this file.")).toBeUndefined();
  });

  it("the package depends on the newest floor of any ELF in the tree", () => {
    expect(maxGlibc(["2.28", undefined, "2.35", "2.17"])).toBe("2.35");
    expect(maxGlibc([undefined])).toBeUndefined();
  });
});

describe("archPkgver", () => {
  it.each([
    ["0.7.0", "0.7.0"],
    ["v1.2.3", "1.2.3"],
    ["0.7.0-rc.1", "0.7.0rc.1"],
  ])("%s → %s", (version, pkgver) => {
    expect(archPkgver(version)).toBe(pkgver);
  });
});

describe("parseSha256File", () => {
  const hash = "a".repeat(64);
  it("reads the digest package-bundle.ts writes", () => {
    expect(parseSha256File(`${hash}  atomic-agent-linux-x64.tar.gz\n`, "atomic-agent-linux-x64.tar.gz")).toBe(hash);
  });
  it("refuses a digest of another file", () => {
    expect(() => parseSha256File(`${hash}  other.tar.gz\n`, "atomic-agent-linux-x64.tar.gz")).toThrow(
      "not a sha256 digest",
    );
  });
});

describe("parseSha256Sums", () => {
  it("reads sha256sum's list, text or binary mode, CRLF or not, and skips what is not a digest", () => {
    const text = [
      `${"A".repeat(64)}  Atomic-Agent-0.0.6-amd64.deb`,
      `${"b".repeat(64)} *Atomic-Agent-0.0.6-arm64.deb`,
      "not a digest line",
      "",
    ].join("\r\n");
    expect(parseSha256Sums(text)).toEqual({
      "Atomic-Agent-0.0.6-amd64.deb": "a".repeat(64),
      "Atomic-Agent-0.0.6-arm64.deb": "b".repeat(64),
    });
  });
});

describe("renderPkgbuild", () => {
  const template = readFileSync("packaging/PKGBUILD.in", "utf8");
  const sums = { "linux-x64": "4".repeat(64), "linux-arm64": "5".repeat(64) };

  it("fills the version, the download base, the archives and every checksum", () => {
    const text = renderPkgbuild(template, { version: "0.7.0", sums, sourceBase: "https://dl/v0.7.0" });
    expect(text).not.toMatch(/@[A-Z0-9_]+@/);
    expect(text).toContain("pkgver=0.7.0\n");
    expect(text).toContain("_version=0.7.0\n");
    expect(text).toContain("_base='https://dl/v0.7.0'");
    expect(text).toContain(
      'source_x86_64=("atomic-agent-${_version}-linux-x64.tar.gz::${_base}/atomic-agent-linux-x64.tar.gz")',
    );
    expect(text).toContain(
      'source_aarch64=("atomic-agent-${_version}-linux-arm64.tar.gz::${_base}/atomic-agent-linux-arm64.tar.gz")',
    );
    expect(text).toContain(`sha256sums_x86_64=('${"4".repeat(64)}')`);
    expect(text).toContain(`sha256sums_aarch64=('${"5".repeat(64)}')`);
    expect(text).toContain("x86_64) slug='linux-x64'");
    expect(text).toContain("aarch64) slug='linux-arm64'");
  });

  it("writes LF line ends from a CRLF template", () => {
    const crlf = template.replace(/\r?\n/g, "\r\n");
    expect(renderPkgbuild(crlf, { version: "0.7.0", sums, sourceBase: "x" })).not.toContain("\r");
  });

  it("refuses a release missing an archive's digest", () => {
    expect(() =>
      renderPkgbuild(template, { version: "0.7.0", sums: { "linux-x64": sums["linux-x64"] }, sourceBase: "x" }),
    ).toThrow("no sha256 for linux-arm64");
  });

  it("fills the desktop template from the release's debs and their SHA256SUMS digests", () => {
    const desktop = readFileSync("packaging/PKGBUILD-desktop.in", "utf8");
    const debSums = {
      "Atomic-Agent-0.0.6-amd64.deb": "6".repeat(64),
      "Atomic-Agent-0.0.6-arm64.deb": "7".repeat(64),
    };
    const text = renderPkgbuild(desktop, { version: "0.0.6", sums: debSums, sourceBase: "https://dl/desktop-v0.0.6" });
    expect(text).not.toMatch(/@[A-Z0-9_]+@/);
    expect(text).toContain("pkgname=atomic-agent-desktop-bin\n");
    expect(text).toContain("pkgver=0.0.6\n");
    expect(text).toContain("_base='https://dl/desktop-v0.0.6'");
    expect(text).toContain('source_x86_64=("${_base}/Atomic-Agent-0.0.6-amd64.deb")');
    expect(text).toContain('source_aarch64=("${_base}/Atomic-Agent-0.0.6-arm64.deb")');
    expect(text).toContain(`sha256sums_x86_64=('${"6".repeat(64)}')`);
    expect(text).toContain(`sha256sums_aarch64=('${"7".repeat(64)}')`);
    expect(text).toContain("noextract=('Atomic-Agent-0.0.6-amd64.deb' 'Atomic-Agent-0.0.6-arm64.deb')");
    // The CLI's digests are not demanded by a template that does not use them.
    expect(() => renderPkgbuild(desktop, { version: "0.0.6", sums: { "Atomic-Agent-0.0.6-amd64.deb": "6".repeat(64) }, sourceBase: "x" }))
      .toThrow("no sha256 for Atomic-Agent-0.0.6-arm64.deb");
  });
});

describe("selectReleases", () => {
  const release = (tag: string, over: Partial<GithubRelease> = {}): GithubRelease => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [{ name: `atomic-agent_${tag.slice(1)}_amd64.deb` }],
    ...over,
  });

  it("keeps the newest published stable releases that carry packages, newest first", () => {
    const releases = [
      release("v0.9.0"),
      release("v0.10.0"),
      release("v0.11.0", { draft: true }),
      release("v0.11.0-rc.1", { prerelease: true }),
      release("v0.2.0", { assets: [{ name: "atomic-agent-linux-x64.tar.gz" }] }),
      release("v0.8.0"),
    ];
    expect(selectReleases(releases, 2)).toEqual([
      { tag: "v0.10.0", version: "0.10.0" },
      { tag: "v0.9.0", version: "0.9.0" },
    ]);
    expect(selectReleases(releases).map((r) => r.tag)).toEqual(["v0.10.0", "v0.9.0", "v0.8.0"]);
  });

  it("keeps each product's own window: desktop releases never count for the CLI, nor the reverse", () => {
    const desktop = (tag: string, over: Partial<GithubRelease> = {}): GithubRelease => ({
      tag_name: tag,
      draft: false,
      prerelease: false,
      assets: [{ name: `Atomic-Agent-${tag.slice("desktop-v".length)}-amd64.deb` }],
      ...over,
    });
    const releases = [
      desktop("desktop-v0.0.5"),
      release("v0.9.0"),
      desktop("desktop-v0.0.6"),
      desktop("desktop-latest", { prerelease: true }),
      desktop("desktop-v0.0.1", { assets: [{ name: "Atomic-Agent-0.0.1-x86_64.AppImage" }] }),
      release("v0.10.0"),
    ];
    expect(selectReleases(releases, 10, PRODUCTS.desktop)).toEqual([
      { tag: "desktop-v0.0.6", version: "0.0.6" },
      { tag: "desktop-v0.0.5", version: "0.0.5" },
    ]);
    expect(selectReleases(releases, 1, PRODUCTS.cli)).toEqual([{ tag: "v0.10.0", version: "0.10.0" }]);
  });
});

describe("repository layout", () => {
  it("puts debs in the pool by package name and rpms beside the dnf metadata", () => {
    expect(repoPath("atomic-agent_0.7.0_amd64.deb")).toBe(
      "deb/pool/main/a/atomic-agent/atomic-agent_0.7.0_amd64.deb",
    );
    expect(repoPath("atomic-agent_0.7.0_x86_64.rpm")).toBe("rpm/packages/atomic-agent_0.7.0_x86_64.rpm");
    expect(repoPath("Atomic-Agent-0.0.6-amd64.deb")).toBe(
      "deb/pool/main/a/atomic-agent-desktop/Atomic-Agent-0.0.6-amd64.deb",
    );
    expect(repoPath("Atomic-Agent-0.0.6-x86_64.rpm")).toBe("rpm/packages/Atomic-Agent-0.0.6-x86_64.rpm");
    expect(() => repoPath("SHA256SUMS.txt")).toThrow("not a package");
  });

  it("writes a .repo that checks the metadata and, when signed, the packages", () => {
    const repo = renderRepoFile({ baseUrl: "https://repo.example" });
    expect(repo).toContain("[atomic-agent]\n");
    expect(repo).toContain("baseurl=https://repo.example/rpm\n");
    expect(repo).toContain("gpgcheck=1\nrepo_gpgcheck=1\n");
    expect(repo).toContain("gpgkey=https://repo.example/atomic-chat.asc\n");
    expect(renderRepoFile({ baseUrl: "http://x", packageSignatures: false })).toContain("gpgcheck=0\n");
  });

  it.each([
    ["deb/pool/main/a/atomic-agent/atomic-agent_0.7.0_amd64.deb", "immutable", "application/vnd.debian.binary-package"],
    ["rpm/packages/atomic-agent_0.7.0_x86_64.rpm", "immutable", "application/x-rpm"],
    ["deb/pool/main/a/atomic-agent-desktop/Atomic-Agent-0.0.6-arm64.deb", "immutable", "application/vnd.debian.binary-package"],
    ["rpm/packages/Atomic-Agent-0.0.6-aarch64.rpm", "immutable", "application/x-rpm"],
    ["deb/dists/stable/InRelease", "no-cache", "text/plain; charset=utf-8"],
    ["deb/dists/stable/Release.gpg", "no-cache", "application/pgp-signature"],
    ["deb/dists/stable/main/binary-amd64/Packages.gz", "no-cache", "application/gzip"],
    ["rpm/repodata/repomd.xml", "no-cache", "application/xml"],
    ["rpm/repodata/repomd.xml.asc", "no-cache", "application/pgp-signature"],
    ["atomic-chat.asc", "no-cache", "application/pgp-keys"],
    ["atomic-chat.gpg", "no-cache", "application/pgp-keys"],
  ])("%s: %s, %s", (path, cache, type) => {
    expect(cacheControl(path)).toContain(cache);
    expect(contentType(path)).toBe(type);
  });
});

describe("syncPlan", () => {
  it("uploads packages, then indexes, then what points at them, and deletes last", () => {
    const local = [
      "atomic-chat.asc",
      "deb/dists/stable/InRelease",
      "deb/dists/stable/main/binary-amd64/Packages",
      "deb/pool/main/a/atomic-agent/atomic-agent_0.8.0_amd64.deb",
      "deb/pool/main/a/atomic-agent/atomic-agent_0.7.0_amd64.deb",
      "rpm/repodata/repomd.xml",
      "rpm/repodata/bbb-primary.xml.gz",
    ];
    const remote = [
      "deb/pool/main/a/atomic-agent/atomic-agent_0.7.0_amd64.deb",
      "deb/pool/main/a/atomic-agent/atomic-agent_0.1.0_amd64.deb",
      "rpm/repodata/aaa-primary.xml.gz",
      "rpm/repodata/repomd.xml",
    ];
    expect(syncPlan(local, remote).map((s) => `${s.op} ${s.path}`)).toEqual([
      "put deb/pool/main/a/atomic-agent/atomic-agent_0.8.0_amd64.deb",
      "put deb/dists/stable/main/binary-amd64/Packages",
      "put rpm/repodata/bbb-primary.xml.gz",
      "put atomic-chat.asc",
      "put deb/dists/stable/InRelease",
      "put rpm/repodata/repomd.xml",
      "delete deb/pool/main/a/atomic-agent/atomic-agent_0.1.0_amd64.deb",
      "delete rpm/repodata/aaa-primary.xml.gz",
    ]);
  });
});

describe("readmeInstallBlock", () => {
  it("returns the shell block after the marker", () => {
    const readme = "x\n<!-- install:apt -->\n\n```bash\nsudo apt install atomic-agent\n```\n";
    expect(readmeInstallBlock(readme, "apt")).toBe("sudo apt install atomic-agent\n");
    expect(() => readmeInstallBlock(readme, "dnf")).toThrow("no <!-- install:dnf -->");
  });

  it("reads a CRLF checkout (Windows) as plain lines", () => {
    const readme = "<!-- install:apt -->\r\n\r\n```sh\r\nsudo apt install atomic-agent\r\n```\r\n";
    expect(readmeInstallBlock(readme, "apt")).toBe("sudo apt install atomic-agent\n");
  });

  it.each(["apt", "dnf"])("finds the %s instructions in README.md, on the repository URL", (name) => {
    expect(readmeInstallBlock(readFileSync("README.md", "utf8"), name)).toContain(REPOSITORY.baseUrl);
  });
});
