import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildOsSandboxPolicy,
  buildSeatbeltProfile,
  formatSandboxUnavailable,
  readOsSandboxSettings,
  SANDBOX_EXEC,
  wrapWithOsSandbox,
} from "./os-sandbox.js";

const HOME = "/home/op";
const TMP = "/var/tmp-op";

function policy(network = false, stateDir = "/home/op/.atomic-agent") {
  return buildOsSandboxPolicy({
    workspaceRoots: ["/home/op/project"],
    stateDir,
    network,
    home: HOME,
    tmp: TMP,
  });
}

describe("readOsSandboxSettings (ATO-469)", () => {
  it("is off unless asked for, and a typo stays off", () => {
    expect(readOsSandboxSettings({})).toEqual({ mode: "off", network: false });
    expect(readOsSandboxSettings({ ATOMIC_AGENT_SANDBOX: "workspce" }).mode).toBe("off");
  });

  it("turns on with workspace, network off unless allowed", () => {
    expect(readOsSandboxSettings({ ATOMIC_AGENT_SANDBOX: "workspace" })).toEqual({
      mode: "workspace",
      network: false,
    });
    expect(
      readOsSandboxSettings({
        ATOMIC_AGENT_SANDBOX: "Workspace",
        ATOMIC_AGENT_SANDBOX_NETWORK: "on",
      }),
    ).toEqual({ mode: "workspace", network: true });
  });
});

describe("buildOsSandboxPolicy", () => {
  it("writes go to the project, temp and tool caches only", () => {
    const p = policy();
    expect(p.writableRoots[0]).toBe("/home/op/project");
    expect(p.writableRoots).toContain(TMP);
    expect(p.writableRoots).toContain("/home/op/.npm/_cacache");
    expect(p.writableRoots).not.toContain(HOME);
  });

  it("never makes a tool's bin, init or settings folder writable", () => {
    const p = policy();
    for (const dir of [".bun", ".bun/bin", ".gradle", ".gradle/init.d", ".m2", ".npm", ".cache"]) {
      expect(p.writableRoots).not.toContain(`/home/op/${dir}`);
    }
    expect(p.writableRoots).toContain("/home/op/.gradle/caches");
    expect(p.writableRoots).toContain("/home/op/.m2/repository");
  });

  it("hides credential folders and the agent's state", () => {
    const p = policy();
    expect(p.denyRead).toContain("/home/op/.ssh");
    expect(p.denyRead).toContain("/home/op/.aws");
    expect(p.denyRead).toContain("/home/op/.atomic-agent");
  });

  it("reopens only a working folder inside the state dir, not the state dir", () => {
    const p = buildOsSandboxPolicy({
      workspaceRoots: ["/home/op/.atomic-agent/workspace"],
      stateDir: "/home/op/.atomic-agent",
      network: false,
      home: HOME,
      tmp: TMP,
    });
    expect(p.denyRead).toContain("/home/op/.atomic-agent");
    expect(p.reopen).toEqual([{ path: "/home/op/.atomic-agent/workspace", write: true }]);
  });

  it("reopens a keep-readable folder read-only and keeps its parent denied", () => {
    const p = buildOsSandboxPolicy({
      workspaceRoots: ["/home/op/project"],
      stateDir: "/home/op/.atomic-agent",
      keepReadable: ["/home/op/.atomic-agent/plugins/installed/p"],
      network: true,
      home: HOME,
      tmp: TMP,
    });
    expect(p.denyRead).toContain("/home/op/.atomic-agent");
    expect(p.reopen).toEqual([
      { path: "/home/op/.atomic-agent/plugins/installed/p", write: false },
    ]);
  });

  it.skipIf(process.platform === "win32")("lists a linked credential folder under its real path too", () => {
    const home = mkdtempSync(join(tmpdir(), "atomic-sbx-home-"));
    try {
      mkdirSync(join(home, "dotfiles/ssh"), { recursive: true });
      symlinkSync(join(home, "dotfiles/ssh"), join(home, ".ssh"));
      const p = buildOsSandboxPolicy({ workspaceRoots: [join(home, "w")], network: false, home, tmp: TMP });
      expect(p.denyRead).toContain(join(home, ".ssh"));
      expect(p.denyRead).toContain(realpathSync(join(home, "dotfiles/ssh")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("buildSeatbeltProfile", () => {
  it("never puts a path into the profile text", () => {
    const p = buildOsSandboxPolicy({
      workspaceRoots: ['/home/op/evil") (allow file-write* (subpath "/'],
      network: false,
      home: HOME,
      tmp: TMP,
    });
    const profile = buildSeatbeltProfile(p);
    expect(profile).not.toContain("evil");
    expect(profile).toContain('(subpath (param "W0"))');
  });

  it("denies all writes before allowing the roots, and blocks the network", () => {
    const profile = buildSeatbeltProfile(policy(false));
    const lines = profile.split("\n");
    expect(lines.indexOf("(deny file-write*)")).toBeLessThan(
      lines.findIndex((l) => l.startsWith("(allow file-write*")),
    );
    expect(profile).toContain("(deny file-read* file-write* (subpath (param \"R0\"))");
    expect(profile).toContain('(deny network-outbound (remote ip "*:*") (remote unix-socket))');
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(profile).toContain('(global-name "com.apple.mDNSResponder")');
    expect(profile).toContain('(global-name "com.apple.coreservices.launchservicesd")');
  });

  it("leaves the network alone when it is allowed", () => {
    const profile = buildSeatbeltProfile(policy(true));
    expect(profile).not.toContain("network-outbound");
    expect(profile).not.toContain("mach-lookup");
  });
});

describe("wrapWithOsSandbox", () => {
  it("wraps with sandbox-exec on macOS, paths as -D parameters", () => {
    const w = wrapWithOsSandbox("/bin/sh", ["-c", "ls"], policy(), {
      platform: "darwin",
      seatbeltAvailable: true,
    });
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.command).toBe(SANDBOX_EXEC);
    expect(w.args).toContain("W0=/home/op/project");
    expect(w.args.slice(-3)).toEqual(["/bin/sh", "-c", "ls"]);
  });

  it("wraps with bwrap on Linux and drops the network", () => {
    const w = wrapWithOsSandbox("/bin/sh", ["-c", "ls"], policy(), {
      platform: "linux",
      bwrap: "/usr/bin/bwrap",
    });
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.command).toBe("/usr/bin/bwrap");
    expect(w.args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
    expect(w.args).toContain("--unshare-net");
    expect(w.args.slice(-4)).toEqual(["--", "/bin/sh", "-c", "ls"]);
  });

  it("covers a secret file with /dev/null and a folder with tmpfs on Linux", () => {
    const home = mkdtempSync(join(tmpdir(), "atomic-sbx-home-"));
    try {
      writeFileSync(join(home, ".netrc"), "machine x login y password z\n");
      mkdirSync(join(home, ".ssh"));
      const p = buildOsSandboxPolicy({ workspaceRoots: [join(home, "w")], network: false, home, tmp: TMP });
      const w = wrapWithOsSandbox("ls", [], p, { platform: "linux", bwrap: "/usr/bin/bwrap" });
      if (!w.ok) throw new Error(w.reason);
      const at = (path: string) => w.args.indexOf(path);
      expect(w.args[at(join(home, ".netrc")) - 1]).toBe("/dev/null");
      expect(w.args[at(join(home, ".netrc")) - 2]).toBe("--ro-bind");
      expect(w.args[at(join(home, ".ssh")) - 1]).toBe("--tmpfs");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("says why when there is no sandbox, and how to turn it off", () => {
    const linux = wrapWithOsSandbox("ls", [], policy(), { platform: "linux", bwrap: null });
    expect(linux.ok).toBe(false);
    const win = wrapWithOsSandbox("ls", [], policy(), { platform: "win32" });
    expect(win.ok).toBe(false);
    if (win.ok) return;
    expect(formatSandboxUnavailable(win.reason)).toContain("ATOMIC_AGENT_SANDBOX");
  });
});
