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
  dockerHostSocket,
  formatSandboxUnavailable,
  MCP_SECRET_HOME_PATHS,
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

  it("never reopens a denied folder itself or anything in a credential folder", () => {
    const p = buildOsSandboxPolicy({
      workspaceRoots: ["/home/op/project"],
      stateDir: "/home/op/.atomic-agent",
      keepReadable: ["/home/op/.atomic-agent", "/home/op/.ssh", "/home/op/.ssh/known_hosts"],
      network: true,
      home: HOME,
      tmp: TMP,
    });
    expect(p.reopen).toEqual([]);
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

describe("ssh-agent socket (ATO-620)", () => {
  const agentPolicy = (sshAuthSock?: string) =>
    buildOsSandboxPolicy({
      workspaceRoots: ["/home/op/project"],
      network: true,
      hideSshAgent: true,
      ...(sshAuthSock === undefined ? {} : { sshAuthSock }),
      home: HOME,
      tmp: TMP,
    });

  it("denies reading and connecting to the launchd and ssh-agent sockets on macOS", () => {
    const profile = buildSeatbeltProfile(agentPolicy("/home/op/agent.sock"));
    expect(profile).toContain('(regex #"^/private/tmp/com\\.apple\\.launchd\\.[^/]+/")');
    expect(profile).toContain('(literal (param "S0"))');
    expect(profile).toMatch(/^\(deny network-outbound .*launchd/m);
    expect(profile).toMatch(/^\(deny file-read\* file-write\* .*launchd/m);
    // Placed after every reopen rule, so nothing reopens it.
    const lines = profile.split("\n");
    const last = Math.max(...lines.map((l, i) => (l.startsWith("(allow file-read*") ? i : -1)));
    expect(lines.findIndex((l) => l.startsWith("(deny network-outbound") && l.includes("launchd"))).toBeGreaterThan(last);
    const w = wrapWithOsSandbox("ls", [], agentPolicy("/home/op/agent.sock"), {
      platform: "darwin",
      seatbeltAvailable: true,
    });
    if (!w.ok) throw new Error(w.reason);
    expect(w.args).toContain("S0=/home/op/agent.sock");
  });

  it("covers the SSH_AUTH_SOCK path with /dev/null on Linux", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-sbx-agent-"));
    try {
      const sock = join(dir, "agent.1");
      writeFileSync(sock, "");
      const w = wrapWithOsSandbox("ls", [], agentPolicy(sock), { platform: "linux", bwrap: "/usr/bin/bwrap" });
      if (!w.ok) throw new Error(w.reason);
      const at = w.args.lastIndexOf(sock);
      expect(w.args[at - 1]).toBe("/dev/null");
      expect(w.args[at - 2]).toBe("--ro-bind");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the agent alone unless asked", () => {
    expect(buildSeatbeltProfile(policy(true))).not.toContain("launchd");
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

// Decisions 18.11: sandboxed MCP servers also lose ~/.npmrc, the shell
// rc and history files and every Docker socket, unless a server opts in.
describe("MCP extras (ATO-620)", () => {
  const mcpPolicy = (extra: { hideDocker?: boolean; dockerHost?: string } = {}) =>
    buildOsSandboxPolicy({
      workspaceRoots: ["/home/op/project"],
      network: true,
      extraDenyRead: MCP_SECRET_HOME_PATHS,
      ...extra,
      home: HOME,
      tmp: TMP,
    });

  it("hides ~/.npmrc and the shell rc and history files", () => {
    const p = mcpPolicy();
    for (const f of [".npmrc", ".zshrc", ".bashrc", ".bash_profile", ".profile", ".zsh_history", ".bash_history"]) {
      expect(p.denyRead).toContain(`/home/op/${f}`);
    }
  });

  it("keeps them for the shell tool, which does not pass extraDenyRead", () => {
    expect(policy().denyRead).not.toContain("/home/op/.npmrc");
  });

  it("denies the Docker sockets and a unix DOCKER_HOST, without the ssh rule", () => {
    const p = mcpPolicy({ hideDocker: true, dockerHost: "unix:///home/op/custom/docker.sock" });
    expect(p.denySockets).toContain("/var/run/docker.sock");
    expect(p.denySockets).toContain("/home/op/.docker/run/docker.sock");
    expect(p.denySockets).toContain("/home/op/custom/docker.sock");
    const profile = buildSeatbeltProfile(p);
    expect(profile).toContain('(literal (param "S0"))');
    expect(profile).toMatch(/^\(deny network-outbound .*S0/m);
    expect(profile).not.toContain("launchd");
  });

  it("leaves Docker alone when the server opts in", () => {
    expect(mcpPolicy().denySockets ?? []).not.toContain("/var/run/docker.sock");
  });

  it("reads only unix DOCKER_HOST values", () => {
    expect(dockerHostSocket("unix:///var/run/x.sock")).toBe("/var/run/x.sock");
    expect(dockerHostSocket("tcp://127.0.0.1:2375")).toBeNull();
    expect(dockerHostSocket(undefined)).toBeNull();
  });

  it("covers a Docker socket path with /dev/null on Linux", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-sbx-docker-"));
    try {
      const sock = join(dir, "docker.sock");
      writeFileSync(sock, "");
      const w = wrapWithOsSandbox("ls", [], mcpPolicy({ hideDocker: true, dockerHost: `unix://${sock}` }), {
        platform: "linux",
        bwrap: "/usr/bin/bwrap",
      });
      if (!w.ok) throw new Error(w.reason);
      const at = w.args.lastIndexOf(sock);
      expect(w.args[at - 1]).toBe("/dev/null");
      expect(w.args[at - 2]).toBe("--ro-bind");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
