import { describe, expect, it } from "vitest";

import {
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
