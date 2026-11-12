import { describe, expect, it } from "vitest";

import {
  SCOOP_MANIFEST_PATH,
  WINGET_CLI_ID,
  WINGET_DESKTOP_ID,
  desktopInstaller,
  parseDigestFile,
  parseReleaseTag,
  parseSha256Sums,
  renderScoopManifest,
  renderWingetCli,
  renderWingetDesktop,
  wingetManifestDir,
  wingetUpdateArgs,
} from "./windows-packaging.js";

// desktop-v0.0.8's own installer digests.
const SETUP_X64 = "c2f9eb538ef441664c1fcd554ee586a7799fe1dc686e13262b3b70ae2bc654d3";
const SETUP_ARM = "2144225788168e385bdf9ddc41bc1babce86863b8d8a4db7dfa77e9aab89a392";
const ZIP = "e".repeat(64);

describe("release tags and assets", () => {
  it("tells the products apart and skips pre-releases", () => {
    expect(parseReleaseTag("v0.7.0")).toEqual({ product: "cli", version: "0.7.0" });
    expect(parseReleaseTag("desktop-v0.0.8")).toEqual({ product: "desktop", version: "0.0.8" });
    expect(parseReleaseTag("v0.8.0-rc.1")).toBeUndefined();
    expect(parseReleaseTag("latest")).toBeUndefined();
  });

  it("names the installers electron-builder writes", () => {
    expect(desktopInstaller("0.0.8", "x64")).toBe("Atomic-Agent-Setup-0.0.8-x64.exe");
    expect(desktopInstaller("0.0.8", "arm64")).toBe("Atomic-Agent-Setup-0.0.8-arm64.exe");
  });

  it("reads digests", () => {
    expect(parseDigestFile(`${ZIP}  atomic-agent-win32-x64.zip\n`)).toBe(ZIP);
    expect(() => parseDigestFile("")).toThrow();
    const sums = parseSha256Sums(`${SETUP_X64}  Atomic-Agent-Setup-0.0.8-x64.exe\n`);
    expect(sums.get("Atomic-Agent-Setup-0.0.8-x64.exe")).toBe(SETUP_X64);
  });
});

describe("the Scoop manifest", () => {
  const manifest = JSON.parse(renderScoopManifest("0.7.0", ZIP)) as Record<string, any>;

  it("unpacks the release zip and shims both commands", () => {
    expect(SCOOP_MANIFEST_PATH).toBe("bucket/atomic-agent.json");
    expect(manifest.version).toBe("0.7.0");
    expect(manifest.architecture["64bit"]).toEqual({
      url: "https://github.com/AtomicBot-ai/atomic-agent/releases/download/v0.7.0/atomic-agent-win32-x64.zip",
      hash: ZIP,
    });
    expect(manifest.bin).toEqual(["atomic-agent.exe", ["atomic-agent.exe", "atag"]]);
    expect(manifest.license).toBe("MIT");
  });

  it("checks for CLI tags only and updates from the published .sha256", () => {
    const regex = new RegExp(manifest.checkver.regex);
    const feed = [
      '<link rel="alternate" href="https://github.com/AtomicBot-ai/atomic-agent/releases/tag/desktop-v0.0.9"/>',
      '<link rel="alternate" href="https://github.com/AtomicBot-ai/atomic-agent/releases/tag/v0.8.0-rc.1"/>',
      '<link rel="alternate" href="https://github.com/AtomicBot-ai/atomic-agent/releases/tag/v0.7.1"/>',
    ].join("\n");
    expect(regex.exec(feed)?.[1]).toBe("0.7.1");
    const auto = manifest.autoupdate.architecture["64bit"];
    expect(auto.url).toContain("/releases/download/v$version/atomic-agent-win32-x64.zip");
    expect(auto.hash).toEqual({ url: "$url.sha256" });
  });

  it("refuses a bad digest or version", () => {
    expect(() => renderScoopManifest("0.7.0", "nope")).toThrow(/sha256/);
    expect(() => renderScoopManifest("v0.7.0", ZIP)).toThrow(/version/);
  });
});

describe("the winget manifests", () => {
  it("lay out the three files where winget-pkgs keeps them", () => {
    expect(wingetManifestDir(WINGET_CLI_ID, "0.7.0")).toBe(
      "manifests/a/AtomicBot/AtomicAgent/CLI/0.7.0",
    );
    const paths = renderWingetDesktop("0.0.8", { x64: SETUP_X64 }).map((f) => f.path);
    expect(paths).toEqual([
      "manifests/a/AtomicBot/AtomicAgent/0.0.8/AtomicBot.AtomicAgent.yaml",
      "manifests/a/AtomicBot/AtomicAgent/0.0.8/AtomicBot.AtomicAgent.installer.yaml",
      "manifests/a/AtomicBot/AtomicAgent/0.0.8/AtomicBot.AtomicAgent.locale.en-US.yaml",
    ]);
  });

  it("the desktop package runs the per-user NSIS installer of each architecture", () => {
    const installer = renderWingetDesktop("0.0.8", { x64: SETUP_X64, arm64: SETUP_ARM })[1]!.text;
    expect(installer).toContain(`PackageIdentifier: ${WINGET_DESKTOP_ID}`);
    expect(installer).toContain('PackageVersion: "0.0.8"');
    expect(installer).toContain("InstallerType: nullsoft");
    expect(installer).toContain("Scope: user");
    expect(installer).toContain(
      '- Architecture: x64\n  InstallerUrl: "https://github.com/AtomicBot-ai/atomic-agent/releases/download/desktop-v0.0.8/Atomic-Agent-Setup-0.0.8-x64.exe"',
    );
    expect(installer).toContain(`InstallerSha256: ${SETUP_X64.toUpperCase()}`);
    expect(installer).toContain("- Architecture: arm64");
    expect(installer).toContain("ManifestType: installer");
    expect(() => renderWingetDesktop("0.0.8", {})).toThrow(/no installers/);
  });

  it("the CLI package unpacks the zip and puts the folder on PATH, not a symlink", () => {
    const [version, installer, locale] = renderWingetCli("0.7.0", ZIP);
    expect(version!.text).toContain("ManifestType: version");
    expect(version!.text).toContain("DefaultLocale: en-US");
    expect(installer!.text).toContain("InstallerType: zip");
    expect(installer!.text).toContain("NestedInstallerType: portable");
    expect(installer!.text).toContain("- RelativeFilePath: atomic-agent.exe");
    // A symlink in WinGet\Links would make the exe look for grammars\ and node_modules\ beside the link.
    expect(installer!.text).toContain("ArchiveBinariesDependOnPath: true");
    expect(installer!.text).not.toContain("PortableCommandAlias");
    expect(installer!.text).toContain("/releases/download/v0.7.0/atomic-agent-win32-x64.zip");
    expect(locale!.text).toContain("PackageName: \"Atomic Agent CLI\"");
    expect(locale!.text).toContain("License: MIT");
    expect(locale!.text).toContain("ReleaseNotesUrl: \"https://github.com/AtomicBot-ai/atomic-agent/releases/tag/v0.7.0\"");
  });

  it("wingetcreate update gets one url|arch per installer", () => {
    expect(
      wingetUpdateArgs(WINGET_DESKTOP_ID, "0.0.9", [
        { arch: "x64", url: "https://x/Setup-x64.exe", sha256: SETUP_X64 },
        { arch: "arm64", url: "https://x/Setup-arm64.exe", sha256: SETUP_ARM },
      ]),
    ).toEqual([
      "update",
      WINGET_DESKTOP_ID,
      "--version",
      "0.0.9",
      "--urls",
      "https://x/Setup-x64.exe|x64",
      "https://x/Setup-arm64.exe|arm64",
    ]);
  });
});
