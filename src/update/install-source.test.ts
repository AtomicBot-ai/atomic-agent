import { describe, expect, it } from "vitest";

import {
  INSTALL_SOURCES,
  managerForPath,
  PACKAGE_MARKER,
  PACKAGED_BINARY,
  packageRemoveHint,
  packageUpgradeHint,
  packagedUpdateRefusal,
  parseInstallSource,
  readInstallSource,
  readShadowedPackage,
  shadowedPackageNotice,
} from "./install-source.js";

describe("readInstallSource", () => {
  const marker = (text: string | undefined) => (path: string) =>
    path === PACKAGE_MARKER ? text : undefined;

  it("names the package when the packaged binary runs and the marker says so", () => {
    for (const source of ["deb", "rpm", "aur"] as const) {
      expect(
        readInstallSource({
          platform: "linux",
          execPath: PACKAGED_BINARY,
          readFile: marker(`${source}\n`),
        }),
      ).toBe(source);
    }
  });

  it("ignores the marker for a binary installed anywhere else", () => {
    // An install.sh copy on a machine that also has the package.
    expect(
      readInstallSource({
        platform: "linux",
        execPath: "/home/op/.local/bin/atomic-agent",
        readFile: marker("deb\n"),
      }),
    ).toBeUndefined();
    expect(
      readInstallSource({
        platform: "linux",
        execPath: "/usr/bin/node",
        readFile: marker("deb\n"),
      }),
    ).toBeUndefined();
  });

  it("is Linux only", () => {
    expect(
      readInstallSource({
        platform: "darwin",
        execPath: PACKAGED_BINARY,
        readFile: marker("deb\n"),
      }),
    ).toBeUndefined();
  });

  it("is undefined without a marker or with one it does not know", () => {
    expect(
      readInstallSource({
        platform: "linux",
        execPath: PACKAGED_BINARY,
        readFile: marker(undefined),
      }),
    ).toBeUndefined();
    expect(
      readInstallSource({
        platform: "linux",
        execPath: PACKAGED_BINARY,
        readFile: marker("snap\n"),
      }),
    ).toBeUndefined();
  });
});

describe("package managers, known by the binary's path", () => {
  const none = () => undefined;
  const cases: ReadonlyArray<[NodeJS.Platform, string, string]> = [
    ["darwin", "/opt/homebrew/lib/node_modules/@atomicbot/atag-darwin-arm64/atomic-agent", "npm"],
    ["linux", "/home/op/.npm-global/lib/node_modules/@atomicbot/atag-linux-x64/atomic-agent", "npm"],
    [
      "win32",
      "C:\\Users\\op\\AppData\\Roaming\\npm\\node_modules\\@atomicbot\\atag-win32-x64\\atomic-agent.exe",
      "npm",
    ],
    ["darwin", "/opt/homebrew/Cellar/atag/0.7.1/libexec/atomic-agent", "homebrew"],
    ["darwin", "/usr/local/Cellar/atag/0.7.1_1/libexec/atomic-agent", "homebrew"],
    ["win32", "C:\\Users\\op\\scoop\\apps\\atomic-agent\\0.7.1\\atomic-agent.exe", "scoop"],
    ["win32", "D:\\tools\\Scoop\\apps\\atomic-agent\\current\\atomic-agent.exe", "scoop"],
    [
      "win32",
      "C:\\Users\\op\\AppData\\Local\\Microsoft\\WinGet\\Packages\\AtomicBot.AtomicAgent.CLI_Microsoft.Winget.Source_8wekyb3d8bbwe\\atomic-agent.exe",
      "winget",
    ],
    ["win32", "C:\\Users\\op\\AppData\\Local\\Microsoft\\WinGet\\Links\\atag.exe", "winget"],
  ];

  it("names the manager from where its copy lives", () => {
    for (const [platform, execPath, source] of cases) {
      expect(managerForPath(platform, execPath), execPath).toBe(source);
      expect(readInstallSource({ platform, execPath, readFile: none }), execPath).toBe(source);
    }
  });

  it("leaves the installers' own copies and anything else alone", () => {
    const others: ReadonlyArray<[NodeJS.Platform, string]> = [
      ["darwin", "/Users/op/.local/bin/atomic-agent"],
      ["linux", "/home/op/.local/bin/atomic-agent"],
      ["win32", "C:\\Users\\op\\AppData\\Local\\atomic-agent\\atomic-agent.exe"],
      // Node itself from Homebrew or npm: not our binary.
      ["darwin", "/opt/homebrew/Cellar/node/25.7.0/bin/node"],
      ["darwin", "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js"],
      // Somebody else's package named like ours.
      ["darwin", "/opt/homebrew/lib/node_modules/@someone/atag-darwin-arm64/atomic-agent"],
      // The Windows layouts mean nothing on another platform.
      ["linux", "/home/op/scoop/apps/atomic-agent/0.7.1/atomic-agent.exe"],
    ];
    for (const [platform, execPath] of others) {
      expect(managerForPath(platform, execPath), execPath).toBeUndefined();
      expect(readInstallSource({ platform, execPath, readFile: none }), execPath).toBeUndefined();
    }
  });

  it("does not take a manager's name from the Linux package marker", () => {
    expect(
      readInstallSource({
        platform: "linux",
        execPath: PACKAGED_BINARY,
        readFile: (path) => (path === PACKAGE_MARKER ? "npm\n" : undefined),
      }),
    ).toBeUndefined();
  });

  it("has a label, an upgrade and a remove command for every source", () => {
    for (const source of INSTALL_SOURCES) {
      expect(packageUpgradeHint(source)).not.toBe("");
      expect(packageRemoveHint(source)).not.toBe("");
      expect(packagedUpdateRefusal(source)).toContain(packageUpgradeHint(source));
    }
    expect(packageUpgradeHint("npm")).toBe("npm install -g atomic-agent@latest");
    expect(packageUpgradeHint("homebrew")).toContain("brew upgrade atag");
    expect(packageUpgradeHint("scoop")).toBe("scoop update atomic-agent");
    expect(packageUpgradeHint("winget")).toBe("winget upgrade AtomicBot.AtomicAgent.CLI");
  });
});

describe("readShadowedPackage", () => {
  const marker = (text: string | undefined) => (path: string) =>
    path === PACKAGE_MARKER ? text : undefined;

  it("names the package when a copy from elsewhere runs beside it", () => {
    expect(
      readShadowedPackage({
        platform: "linux",
        execPath: "/home/op/.local/bin/atomic-agent",
        readFile: marker("deb\n"),
      }),
    ).toBe("deb");
  });

  it("is undefined for the packaged binary itself, off Linux, and without a package", () => {
    expect(
      readShadowedPackage({
        platform: "linux",
        execPath: PACKAGED_BINARY,
        readFile: marker("deb\n"),
      }),
    ).toBeUndefined();
    expect(
      readShadowedPackage({
        platform: "darwin",
        execPath: "/Users/op/.local/bin/atomic-agent",
        readFile: marker("deb\n"),
      }),
    ).toBeUndefined();
    expect(
      readShadowedPackage({
        platform: "linux",
        execPath: "/home/op/.local/bin/atomic-agent",
        readFile: marker(undefined),
      }),
    ).toBeUndefined();
  });

  it("the notice names the running copy, its directory and the package's path", () => {
    const text = shadowedPackageNotice("rpm", "/home/op/.local/bin/atomic-agent");
    expect(text).toContain("the rpm package");
    expect(text).toContain("/usr/bin/atomic-agent");
    expect(text).toContain("this updates only /home/op/.local/bin/atomic-agent");
    expect(text).toContain("remove /home/op/.local/bin/atomic-agent and /home/op/.local/bin/atag");
  });
});

describe("parseInstallSource", () => {
  it("trims and lower-cases, and refuses anything outside the list", () => {
    expect(parseInstallSource(" RPM\n")).toBe("rpm");
    expect(parseInstallSource("flatpak")).toBeUndefined();
    expect(parseInstallSource(undefined)).toBeUndefined();
  });
});

describe("package hints", () => {
  it("name the package manager's own commands", () => {
    expect(packageUpgradeHint("deb")).toContain("apt");
    expect(packageUpgradeHint("rpm")).toContain("dnf");
    expect(packageUpgradeHint("aur")).toContain("atomic-agent-bin");
    expect(packageRemoveHint("deb")).toBe("sudo apt remove atomic-agent");
    expect(packageRemoveHint("rpm")).toBe("sudo dnf remove atomic-agent");
    expect(packageRemoveHint("aur")).toBe("sudo pacman -R atomic-agent-bin");
  });

  it("the refusal says who installed it and what to run", () => {
    const text = packagedUpdateRefusal("deb");
    expect(text).toContain("the deb package");
    expect(text).toContain(packageUpgradeHint("deb"));
  });
});
