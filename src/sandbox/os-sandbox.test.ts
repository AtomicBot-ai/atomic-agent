import { describe, expect, it } from "vitest";

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
    cwd: "/home/op/project",
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
    expect(p.writableRoots).toContain("/home/op/.npm");
    expect(p.writableRoots).not.toContain(HOME);
  });

  it("hides credential folders and the agent's state", () => {
    const p = policy();
    expect(p.denyRead).toContain("/home/op/.ssh");
    expect(p.denyRead).toContain("/home/op/.aws");
    expect(p.denyRead).toContain("/home/op/.atomic-agent");
  });

  it("keeps a working folder inside the state dir readable", () => {
    const p = buildOsSandboxPolicy({
      cwd: "/home/op/.atomic-agent/workspace",
      stateDir: "/home/op/.atomic-agent",
      network: false,
      home: HOME,
      tmp: TMP,
    });
    expect(p.denyRead).not.toContain("/home/op/.atomic-agent");
    expect(p.denyRead).toContain("/home/op/.ssh");
  });
});

describe("buildSeatbeltProfile", () => {
  it("never puts a path into the profile text", () => {
    const p = buildOsSandboxPolicy({
      cwd: '/home/op/evil") (allow file-write* (subpath "/',
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
    expect(profile).toContain('(deny network-outbound (remote ip "*:*"))');
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
  });

  it("leaves the network alone when it is allowed", () => {
    expect(buildSeatbeltProfile(policy(true))).not.toContain("network-outbound");
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

  it("says why when there is no sandbox, and how to turn it off", () => {
    const linux = wrapWithOsSandbox("ls", [], policy(), { platform: "linux", bwrap: null });
    expect(linux.ok).toBe(false);
    const win = wrapWithOsSandbox("ls", [], policy(), { platform: "win32" });
    expect(win.ok).toBe(false);
    if (win.ok) return;
    expect(formatSandboxUnavailable(win.reason)).toContain("ATOMIC_AGENT_SANDBOX");
  });
});
