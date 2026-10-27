import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectOtherSurfaceInstalled,
  otherSurfaceAnalyticsExists,
  resolveAnalyticsDimensions,
  resolveDesktopVersion,
  resolveInstallChannel,
} from "./resolve-analytics-dimensions.js";

describe("analytics dimensions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-dims-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the install channel marker written by the install scripts", () => {
    writeFileSync(join(dir, "install-channel"), "curl_sh\n", "utf8");
    expect(resolveInstallChannel(dir, {})).toBe("curl_sh");
  });

  it("strips a BOM and CRLF from a Windows-written marker", () => {
    writeFileSync(join(dir, "install-channel"), "\uFEFFcurl_ps1\r\n", "utf8");
    expect(resolveInstallChannel(dir, {})).toBe("curl_ps1");
  });

  it("reports the package that installed the running binary over a stale marker", () => {
    // An install.sh copy was replaced by the rpm; the per-user marker still
    // says curl_sh, but the binary running is the package's.
    writeFileSync(join(dir, "install-channel"), "curl_sh\n", "utf8");
    const packaged = {
      platform: "linux" as const,
      execPath: "/usr/lib/atomic-agent/atomic-agent",
      readFile: (path: string) =>
        path === "/usr/lib/atomic-agent/install-source" ? "rpm\n" : undefined,
    };
    expect(resolveInstallChannel(dir, {}, packaged)).toBe("rpm");
    expect(resolveInstallChannel(dir, {}, { ...packaged, readFile: () => undefined })).toBe(
      "curl_sh",
    );
    expect(
      resolveInstallChannel(dir, {}, { ...packaged, execPath: "/home/op/.local/bin/atomic-agent" }),
    ).toBe("curl_sh");
  });

  it("lets the env set by the desktop app win over the marker", () => {
    writeFileSync(join(dir, "install-channel"), "curl_sh\n", "utf8");
    expect(
      resolveInstallChannel(dir, { ATOMIC_AGENT_INSTALL_CHANNEL: "dmg" }),
    ).toBe("dmg");
  });

  it("falls back to unknown for a missing or unrecognised channel", () => {
    expect(resolveInstallChannel(dir, {})).toBe("unknown");
    writeFileSync(join(dir, "install-channel"), "/Users/me/x\n", "utf8");
    expect(
      resolveInstallChannel(dir, { ATOMIC_AGENT_INSTALL_CHANNEL: "brew?" }),
    ).toBe("unknown");
  });

  it("keeps only version-shaped desktop versions", () => {
    expect(resolveDesktopVersion({ ATOMIC_AGENT_DESKTOP_VERSION: "0.6.7" })).toBe(
      "0.6.7",
    );
    expect(
      resolveDesktopVersion({ ATOMIC_AGENT_DESKTOP_VERSION: "/opt/app" }),
    ).toBeUndefined();
    expect(resolveDesktopVersion({})).toBeUndefined();
  });

  it("builds the full dimension set for a desktop-spawned agent", () => {
    const dims = resolveAnalyticsDimensions({
      stateDir: dir,
      env: {
        ATOMIC_AGENT_SURFACE: "desktop",
        ATOMIC_AGENT_INSTALL_CHANNEL: "exe",
        ATOMIC_AGENT_DESKTOP_VERSION: "0.6.7",
      },
    });
    expect(dims).toEqual({
      surface: "desktop",
      arch: process.arch,
      installChannel: "exe",
      desktopVersion: "0.6.7",
    });
  });

  it("builds the terminal dimension set without desktop_version", () => {
    const dims = resolveAnalyticsDimensions({
      stateDir: dir,
      surface: "tui",
      env: {},
    });
    expect(dims).toEqual({
      surface: "tui",
      arch: process.arch,
      installChannel: "unknown",
    });
  });

  it("checks the other surface's state dir for analytics.json", () => {
    expect(otherSurfaceAnalyticsExists("tui", dir)).toBe(false);
    mkdirSync(join(dir, ".atomic-agent-desktop"), { recursive: true });
    writeFileSync(join(dir, ".atomic-agent-desktop", "analytics.json"), "{}");
    expect(otherSurfaceAnalyticsExists("tui", dir)).toBe(true);
    expect(otherSurfaceAnalyticsExists("desktop", dir)).toBe(false);
  });

  it("never looks at the home dir under the test runner", () => {
    mkdirSync(join(dir, ".atomic-agent"), { recursive: true });
    writeFileSync(join(dir, ".atomic-agent", "analytics.json"), "{}");
    expect(detectOtherSurfaceInstalled("desktop", dir, { VITEST: "1" })).toBe(
      false,
    );
    expect(detectOtherSurfaceInstalled("desktop", dir, {})).toBe(true);
  });
});
