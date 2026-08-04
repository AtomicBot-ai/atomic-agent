import { describe, it, expect } from "vitest";
import {
  canSelfUpdate,
  buildUpdateInvocation,
  formatInstallFailure,
} from "./run-app-update.js";

describe("canSelfUpdate", () => {
  it("allows the installed binary on POSIX", () => {
    expect(canSelfUpdate("linux", "/home/u/.local/bin/atomic-agent")).toBe(true);
    expect(canSelfUpdate("darwin", "/Users/u/.local/bin/atomic-agent")).toBe(
      true,
    );
  });

  it("allows the installed binary on Windows", () => {
    expect(
      canSelfUpdate("win32", "C:\\Users\\u\\AppData\\Local\\atomic-agent\\atomic-agent.exe"),
    ).toBe(true);
  });

  it("rejects dev runtimes (node / tsx)", () => {
    expect(canSelfUpdate("linux", "/usr/bin/node")).toBe(false);
    expect(canSelfUpdate("win32", "C:\\Program Files\\nodejs\\node.exe")).toBe(
      false,
    );
    expect(canSelfUpdate("darwin", "/opt/homebrew/bin/tsx")).toBe(false);
  });

  it("rejects unrelated binaries", () => {
    expect(canSelfUpdate("linux", "/usr/bin/bash")).toBe(false);
  });
});

describe("buildUpdateInvocation", () => {
  it("builds a POSIX sh invocation against install.sh", () => {
    const inv = buildUpdateInvocation({
      platform: "linux",
      repo: "AtomicBot-ai/atomic-agent",
      installDir: "/home/u/.local/bin",
      baseEnv: {},
    });
    expect(inv.command).toBe("sh");
    expect(inv.args[0]).toBe("-c");
    expect(inv.args[1]).toContain("install.sh");
    expect(inv.args[1]).toContain("curl -fsSL");
    expect(inv.args[1]).toContain("| sh");
    expect(inv.env.ATOMIC_AGENT_INSTALL_DIR).toBe("/home/u/.local/bin");
    expect(inv.env.ATOMIC_AGENT_NO_PATH).toBe("1");
    expect(inv.env.ATOMIC_AGENT_REPO).toBe("AtomicBot-ai/atomic-agent");
    expect(inv.env.ATOMIC_AGENT_VERSION).toBeUndefined();
  });

  it("builds a Windows powershell invocation against install.ps1", () => {
    const inv = buildUpdateInvocation({
      platform: "win32",
      repo: "AtomicBot-ai/atomic-agent",
      installDir: "C:\\Users\\u\\AppData\\Local\\atomic-agent",
      baseEnv: {},
    });
    expect(inv.command).toBe("powershell.exe");
    expect(inv.args).toContain("-NoProfile");
    expect(inv.args).toContain("-Command");
    const psCommand = inv.args[inv.args.length - 1];
    expect(psCommand).toContain("install.ps1");
    expect(psCommand).toContain("irm ");
    expect(psCommand).toContain("| iex");
    expect(inv.env.ATOMIC_AGENT_INSTALL_DIR).toBe(
      "C:\\Users\\u\\AppData\\Local\\atomic-agent",
    );
    expect(inv.env.ATOMIC_AGENT_NO_PATH).toBe("1");
  });

  it("pins a version when provided", () => {
    const inv = buildUpdateInvocation({
      platform: "win32",
      repo: "AtomicBot-ai/atomic-agent",
      installDir: "C:\\x",
      version: "v0.1.60",
      baseEnv: {},
    });
    expect(inv.env.ATOMIC_AGENT_VERSION).toBe("v0.1.60");
  });

  it("preserves the base environment", () => {
    const inv = buildUpdateInvocation({
      platform: "linux",
      repo: "owner/repo",
      installDir: "/x",
      baseEnv: { HOME: "/home/u", PATH: "/usr/bin" },
    });
    expect(inv.env.HOME).toBe("/home/u");
    expect(inv.env.PATH).toBe("/usr/bin");
    expect(inv.env.ATOMIC_AGENT_REPO).toBe("owner/repo");
  });
});

describe("formatInstallFailure", () => {
  it("should attach the installer's own reason to the exit code", () => {
    const message = formatInstallFailure(1, [
      "downloading atomic-agent-win32-x64.zip from AtomicBot-ai/atomic-agent ...",
      "error: download failed: https://github.com/o/r/releases/latest/download/a.zip",
    ]);
    expect(message).toContain("install script exited with code 1");
    expect(message).toContain("error: download failed:");
    expect(message.split("\n")).toHaveLength(3);
  });

  it("should say so explicitly when the installer produced no output", () => {
    expect(formatInstallFailure(1, [])).toBe(
      "install script exited with code 1 (no output)",
    );
  });

  it("should render a null exit code (killed by signal) without crashing", () => {
    expect(formatInstallFailure(null, ["boom"])).toContain(
      "exited with code unknown",
    );
  });
});
