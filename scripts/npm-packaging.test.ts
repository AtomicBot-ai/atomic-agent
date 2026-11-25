import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BUNDLE_TARGETS } from "./bundle-targets.js";
import {
  archiveName,
  distTag,
  launcherManifest,
  platformManifest,
  platformPackageName,
  publishOrder,
  sanitizeBundledManifest,
  targetForSlug,
  versionFromTag,
} from "./npm-packaging.js";
// The launcher's own table: published as-is, so it must agree with the release matrix.
import * as launcher from "../packaging/npm/atomic-agent/lib/platform.js";

const LAUNCHER_DIR = fileURLToPath(new URL("../packaging/npm/atomic-agent/", import.meta.url));

describe("npm packages of a release", () => {
  it("one platform package per release target, named the way the launcher looks for it", () => {
    expect([...launcher.SLUGS].sort()).toEqual(BUNDLE_TARGETS.map((t) => t.slug).sort());
    for (const target of BUNDLE_TARGETS) {
      expect(launcher.platformPackageName(target.slug)).toBe(platformPackageName(target.slug));
      expect(launcher.slugFor(target.platform, target.arch)).toBe(target.slug);
      expect(launcher.executableName(target.platform)).toBe(target.executableName);
    }
    expect(launcher.slugFor("freebsd", "x64")).toBeUndefined();
    expect(launcher.slugFor("linux", "ia32")).toBeUndefined();
    expect(platformPackageName("darwin-arm64")).toBe("@atomicbot/atag-darwin-arm64");
  });

  it("reads the release asset names package-bundle.ts writes", () => {
    expect(archiveName(targetForSlug("darwin-arm64"))).toBe("atomic-agent-darwin-arm64.tar.gz");
    expect(archiveName(targetForSlug("win32-x64"))).toBe("atomic-agent-win32-x64.zip");
    expect(() => targetForSlug("darwin-ppc")).toThrow(/unknown target/);
  });

  it("takes the version from a CLI tag only", () => {
    expect(versionFromTag("v0.7.1")).toBe("0.7.1");
    expect(versionFromTag("v1.0.0-rc.1")).toBe("1.0.0-rc.1");
    expect(() => versionFromTag("desktop-v0.0.8")).toThrow(/not a CLI release tag/);
    expect(() => versionFromTag("0.7.1")).toThrow();
    expect(() => versionFromTag("v0.7")).toThrow();
  });

  it("keeps pre-releases off the latest dist-tag", () => {
    expect(distTag("0.7.1")).toBe("latest");
    expect(distTag("0.8.0-rc.1")).toBe("next");
    expect(distTag("0.7.1+build.5")).toBe("latest");
  });

  it("a platform package pins os/cpu and bundles the runtime node_modules", () => {
    const manifest = platformManifest({
      slug: "linux-arm64",
      version: "0.7.1",
      bundled: { "playwright-core": "1.56.0", "better-sqlite3": "12.4.1", bindings: "1.5.0" },
    });
    expect(manifest.name).toBe("@atomicbot/atag-linux-arm64");
    expect(manifest.version).toBe("0.7.1");
    expect(manifest.os).toEqual(["linux"]);
    expect(manifest.cpu).toEqual(["arm64"]);
    expect(manifest.libc).toEqual(["glibc"]);
    expect(manifest.bundleDependencies).toEqual(["better-sqlite3", "bindings", "playwright-core"]);
    // Bundled packages missing from dependencies are pruned at install.
    expect(manifest.dependencies).toEqual({
      "better-sqlite3": "12.4.1",
      bindings: "1.5.0",
      "playwright-core": "1.56.0",
    });
    expect(manifest).not.toHaveProperty("bin");
    expect(manifest).not.toHaveProperty("scripts");
    const mac = platformManifest({ slug: "darwin-arm64", version: "0.7.1", bundled: {} });
    expect(mac).not.toHaveProperty("libc");
    expect(mac.bundleDependencies).toEqual([]);
  });

  it("strips what npm would run from a bundled manifest", () => {
    const betterSqlite = {
      name: "better-sqlite3",
      version: "12.4.1",
      main: "lib/index.js",
      gypfile: true,
      scripts: { install: "prebuild-install || node-gyp rebuild --release" },
      dependencies: { bindings: "^1.5.0", "prebuild-install": "^7.1.1" },
      devDependencies: { mocha: "*" },
    };
    const out = sanitizeBundledManifest(betterSqlite, new Set(["better-sqlite3", "bindings"]));
    expect(out).toEqual({
      name: "better-sqlite3",
      version: "12.4.1",
      main: "lib/index.js",
      dependencies: { bindings: "^1.5.0" },
    });
    // The input is left as it was.
    expect(betterSqlite.scripts.install).toContain("node-gyp");
    expect(
      sanitizeBundledManifest({ name: "x", dependencies: { y: "1" } }, new Set(["x"])),
    ).toEqual({ name: "x" });
  });

  it("the launcher depends on exactly the staged platform packages at the same version", () => {
    const template = JSON.parse(readFileSync(join(LAUNCHER_DIR, "package.json"), "utf8")) as Record<string, unknown>;
    const manifest = launcherManifest(template, "0.7.1", ["win32-x64", "darwin-arm64"]);
    expect(manifest.name).toBe("atomic-agent");
    expect(manifest.version).toBe("0.7.1");
    expect(manifest.optionalDependencies).toEqual({
      "@atomicbot/atag-darwin-arm64": "0.7.1",
      "@atomicbot/atag-win32-x64": "0.7.1",
    });
    expect(manifest.bin).toEqual({ atag: "bin/atag.js", "atomic-agent": "bin/atag.js" });
    expect(() => launcherManifest(template, "0.7.1", [])).toThrow();
  });

  it("publishes every platform package before the launcher", () => {
    expect(publishOrder(["win32-x64", "darwin-arm64"])).toEqual([
      "darwin-arm64",
      "win32-x64",
      "atomic-agent",
    ]);
  });
});
