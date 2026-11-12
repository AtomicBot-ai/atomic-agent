import { describe, expect, it } from "vitest";

import {
  CASK_PATH,
  FORMULA_PATH,
  cliArchive,
  compareVersions,
  desktopDmg,
  parseDigestFile,
  parseReleaseTag,
  parseSha256Sums,
  renderCask,
  renderFormula,
  renderedVersion,
} from "./homebrew-packaging.js";

// The v0.7.0 and desktop-v0.0.8 releases' own digests.
const CLI_ARM = "a1f8d4bec9f12873c06cf8388a90cb998aab5f0c133f4c036c2fd15d41f51472";
const DMG_ARM = "0c21b165db95b65e7aec82b00763b540eff86c5bc7ca71d0f44d02b47609ae21";
const OTHER = "f".repeat(64);

describe("release tags", () => {
  it("tells the CLI from the desktop app and skips pre-releases", () => {
    expect(parseReleaseTag("v0.7.0")).toEqual({ product: "cli", version: "0.7.0" });
    expect(parseReleaseTag("desktop-v0.0.8")).toEqual({ product: "desktop", version: "0.0.8" });
    expect(parseReleaseTag("v0.8.0-rc.1")).toBeUndefined();
    expect(parseReleaseTag("desktop-v0.1.0-beta")).toBeUndefined();
    expect(parseReleaseTag("nightly")).toBeUndefined();
  });

  it("names the assets the release workflows upload", () => {
    expect(cliArchive("arm64")).toBe("atomic-agent-darwin-arm64.tar.gz");
    expect(desktopDmg("0.0.8", "arm64")).toBe("Atomic-Agent-0.0.8-arm64.dmg");
    expect(desktopDmg("0.0.9", "x64")).toBe("Atomic-Agent-0.0.9-x64.dmg");
    expect(FORMULA_PATH).toBe("Formula/atag.rb");
    expect(CASK_PATH).toBe("Casks/atomic-agent.rb");
  });
});

describe("digests", () => {
  it("reads a .sha256 file and SHA256SUMS.txt", () => {
    expect(parseDigestFile(`${CLI_ARM}  atomic-agent-darwin-arm64.tar.gz\n`)).toBe(CLI_ARM);
    expect(() => parseDigestFile("not found")).toThrow(/sha256/);
    const sums = parseSha256Sums(
      `${DMG_ARM}  Atomic-Agent-0.0.8-arm64.dmg\r\n${OTHER} *Atomic-Agent-Setup-0.0.8-x64.exe\n\n`,
    );
    expect(sums.get("Atomic-Agent-0.0.8-arm64.dmg")).toBe(DMG_ARM);
    expect(sums.get("Atomic-Agent-Setup-0.0.8-x64.exe")).toBe(OTHER);
    expect(sums.size).toBe(2);
  });
});

describe("the atag formula", () => {
  it("installs the Apple silicon bundle whole and links both commands", () => {
    const ruby = renderFormula("0.7.0", { arm64: CLI_ARM });
    expect(ruby).toContain("class Atag < Formula");
    expect(ruby).toContain('version "0.7.0"');
    expect(ruby).toContain(
      'url "https://github.com/AtomicBot-ai/atomic-agent/releases/download/v0.7.0/atomic-agent-darwin-arm64.tar.gz"',
    );
    expect(ruby).toContain(`sha256 "${CLI_ARM}"`);
    expect(ruby).toContain("depends_on :macos");
    // Without an Intel build an Intel Mac is refused up front, not handed an arm64 binary.
    expect(ruby).toContain("depends_on arch: :arm64");
    expect(ruby).not.toContain("on_intel");
    expect(ruby).toContain('libexec.install Dir["*"]');
    expect(ruby).toContain('bin.install_symlink libexec/"atomic-agent" => "atag"');
    expect(ruby).toContain('shell_output("#{bin}/atag --version")');
    expect(renderedVersion(ruby)).toBe("0.7.0");
    // Never the desktop's tags.
    expect(ruby).toContain("regex(/^v(\\d+(?:\\.\\d+)+)$/i)");
  });

  it("adds the Intel bundle when the release has one", () => {
    const ruby = renderFormula("0.7.1", { arm64: CLI_ARM, x64: OTHER });
    expect(ruby).toMatch(/on_arm do\n\s+url ".*darwin-arm64\.tar\.gz"\n\s+sha256 "a1f8/);
    expect(ruby).toMatch(/on_intel do\n\s+url ".*darwin-x64\.tar\.gz"\n\s+sha256 "f{64}"/);
    expect(ruby).not.toContain("depends_on arch:");
  });

  it("refuses a release without a Mac bundle or with a bad digest", () => {
    expect(() => renderFormula("0.7.0", {})).toThrow(/no macOS/);
    expect(() => renderFormula("0.7.0", { arm64: "abc" })).toThrow(/bad sha256/);
    expect(() => renderFormula("v0.7.0", { arm64: CLI_ARM })).toThrow(/not a release version/);
  });
});

describe("the atomic-agent cask", () => {
  it("installs the DMG, leaves updates to the app and keeps the shared data dir", () => {
    const ruby = renderCask("0.0.8", { arm64: DMG_ARM });
    expect(ruby).toContain('cask "atomic-agent" do');
    expect(ruby).toContain('version "0.0.8"');
    expect(ruby).toContain(`sha256 "${DMG_ARM}"`);
    expect(ruby).toContain(
      'url "https://github.com/AtomicBot-ai/atomic-agent/releases/download/desktop-v#{version}/Atomic-Agent-#{version}-arm64.dmg",',
    );
    expect(ruby).toContain('verified: "github.com/AtomicBot-ai/atomic-agent/"');
    expect(ruby).toContain('app "Atomic Agent.app"');
    expect(ruby).toContain("auto_updates true");
    expect(ruby).toContain("depends_on arch: :arm64");
    expect(ruby).toContain("strategy :github_releases");
    // The terminal shares ~/.atomic-agent with the app: zap must not take it.
    expect(ruby).not.toMatch(/"~\/\.atomic-agent/);
  });

  it("switches on arch when the release has both DMGs", () => {
    const ruby = renderCask("0.0.9", { arm64: DMG_ARM, x64: OTHER });
    expect(ruby).toContain('arch arm: "arm64", intel: "x64"');
    expect(ruby).toContain(`sha256 arm:   "${DMG_ARM}",`);
    expect(ruby).toContain(`intel: "${OTHER}"`);
    expect(ruby).toContain("Atomic-Agent-#{version}-#{arch}.dmg");
    expect(ruby).not.toContain("depends_on arch:");
  });
});

describe("compareVersions", () => {
  it("orders X.Y.Z numerically", () => {
    expect(compareVersions("0.7.10", "0.7.9")).toBe(1);
    expect(compareVersions("0.7.0", "0.7.0")).toBe(0);
    expect(compareVersions("0.6.13", "0.7.0")).toBe(-1);
  });
});
