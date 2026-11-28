import { describe, expect, it, vi } from "vitest";

import { launchApprovalNote, MASKED, parseLaunchArgs } from "./launch-command.js";
import { fakeSpawn, run, SERVE } from "./launch-command-test-helpers.js";

describe("atag launch (ATO-2172)", () => {
  it("parses the agent, --model and the args after --", () => {
    const parsed = parseLaunchArgs(["codex", "--model", "qwen", "--", "exec", "--json"]);
    expect(parsed).toMatchObject({ model: "qwen", printEnv: false, extraArgs: ["exec", "--json"] });
    expect(parseLaunchArgs(["nope"])).toEqual({ error: expect.stringContaining("unknown agent nope") });
    expect(parseLaunchArgs([])).toMatchObject({ integration: null });
    expect(parseLaunchArgs(["claude", "--help"])).toBe("help");
  });

  it("a missing binary exits 1 with the install hint and starts no serve", async () => {
    const startServe = vi.fn();
    const findServe = vi.fn();
    const r = await run(["claude"], { findBinary: () => null, startServe, findServe, isTTY: () => false });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Claude Code is not installed");
    expect(r.err).toContain("npm install -g @anthropic-ai/claude-code");
    expect(findServe).not.toHaveBeenCalled();
    expect(startServe).not.toHaveBeenCalled();
  });

  it("--print-env masks the key and runs nothing", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const startServe = vi.fn();
    const r = await run(["claude", "--print-env"], { spawn, startServe });
    expect(r.code).toBe(0);
    expect(r.out).toContain("export ANTHROPIC_BASE_URL=http://127.0.0.1:41234/local\n");
    expect(r.out).toContain(`export ANTHROPIC_AUTH_TOKEN='${MASKED}'`);
    expect(r.out).not.toContain("the-lasting-token");
    expect(r.err).not.toContain("the-lasting-token");
    expect(r.out + r.err).not.toContain("the-serve-key");
    expect(calls).toHaveLength(0);
    expect(startServe).not.toHaveBeenCalled();
  });

  it("--print-env for codex masks the token variable too", async () => {
    const r = await run(["codex", "--print-env"]);
    expect(r.out).toContain(`export ATOMIC_AGENT_TOKEN='${MASKED}'`);
    expect(r.out).not.toContain("the-lasting-token");
    expect(r.out).toContain("/usr/local/bin/codex -c");
  });

  it("--print-env on Windows prints PowerShell lines by default, and --shell picks another (ATO-2758)", async () => {
    const win = await run(["claude", "--print-env"], { platform: "win32" });
    expect(win.out).toContain("$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:41234/local'");
    expect(win.out).toContain(`$env:ANTHROPIC_AUTH_TOKEN = '${MASKED}'`);
    expect(win.out).not.toContain("export ");
    expect(win.out).not.toContain("the-lasting-token");
    const cmd = await run(["claude", "--print-env", "--shell", "cmd"], { platform: "win32" });
    expect(cmd.out).toContain('set "ANTHROPIC_BASE_URL=http://127.0.0.1:41234/local"');
    const posix = await run(["claude", "--print-env", "--shell=posix"], { platform: "win32" });
    expect(posix.out).toContain("export ANTHROPIC_BASE_URL=http://127.0.0.1:41234/local\n");
    expect(parseLaunchArgs(["claude", "--shell", "fish"])).toEqual({ error: expect.stringContaining("--shell expects") });
  });

  it("runs the CLI with the env on top of the inherited one and forwards its exit code", async () => {
    const { spawn, calls } = fakeSpawn(7);
    const r = await run(["claude", "--", "--continue"], { spawn });
    expect(r.code).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("/usr/local/bin/claude");
    expect(calls[0]?.args).toEqual(["--continue"]);
    expect(calls[0]?.env).toMatchObject({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:41234/local",
      ANTHROPIC_AUTH_TOKEN: "the-run-token",
      ANTHROPIC_MODEL: "qwen-local",
    });
    expect(JSON.stringify(calls[0]?.env)).not.toContain("the-serve-key");
    expect(r.err).not.toContain("the-run-token");
  });

  it("a CLI killed by a signal exits 128 + the signal number", async () => {
    const { spawn } = fakeSpawn(null, "SIGTERM");
    const r = await run(["opencode"], { spawn });
    expect(r.code).toBe(128 + 15);
  });

  it("starts a serve when none runs in the folder", async () => {
    const { spawn } = fakeSpawn(0);
    const startServe = vi.fn(async () => ({ ...SERVE, started: true }));
    const r = await run(["codex"], { spawn, findServe: async () => null, startServe });
    expect(r.code).toBe(0);
    expect(startServe).toHaveBeenCalledWith("/state", "/work");
  });

  it("a serve that cannot start exits 1 and runs nothing", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const r = await run(["codex"], {
      spawn,
      findServe: async () => null,
      startServe: async () => ({ error: "atag serve stopped while starting (log: x)" }),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("atag serve stopped while starting");
    expect(calls).toHaveLength(0);
  });

  it("a serve that refuses the key exits 1 before the CLI runs", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const local = await run(["claude"], { spawn, probeLocal: async () => ({ ok: false, reason: "auth" }) });
    expect(local.code).toBe(1);
    expect(local.err).toContain("does not accept the key");
    const r = await run(["claude", "--agent"], { spawn, checkKey: async () => false });
    expect(r.code).toBe(1);
    expect(r.err).toContain("does not accept the key");
    expect(calls).toHaveLength(0);
  });

  it("an unknown agent is a usage error", async () => {
    const r = await run(["gemini"]);
    expect(r.code).toBe(2);
  });

  it("bare `atag launch` without a terminal lists the CLIs and exits 0 without the help (ATO-2737)", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const r = await run([], { spawn, isTTY: () => false, findBinary: (b) => (b === "claude" ? "/usr/local/bin/claude" : null) });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1\. claude\s+Claude Code\s+installed/);
    expect(r.out).toContain("not installed (npm install -g @openai/codex)");
    expect(r.out).toContain("atag launch <name>");
    expect(r.err).not.toContain("missing agent name");
    expect(r.err).not.toContain("Usage:");
    expect(calls).toHaveLength(0);
  });

  it("bare `atag launch` in a terminal starts the CLI picked by number (ATO-2737)", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const r = await run([], { spawn, isTTY: () => true, ask: async () => "2" });
    expect(r.code).toBe(0);
    expect(calls[0]?.cmd).toBe("/usr/local/bin/codex");
  });

  it("bare `atag launch` in a terminal: Enter starts nothing, a wrong answer is a usage error (ATO-2737)", async () => {
    const { spawn, calls } = fakeSpawn(0);
    expect((await run([], { spawn, isTTY: () => true, ask: async () => "" })).code).toBe(0);
    expect((await run([], { spawn, isTTY: () => true, ask: async () => "vim" })).code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("the approval note names a real address, never a <port> placeholder (ATO-2737)", () => {
    const started = launchApprovalNote({ baseUrl: "http://127.0.0.1:41234", started: true });
    expect(started).toContain("http://127.0.0.1:8787/panel");
    expect(started).not.toContain("<port>");
    expect(launchApprovalNote({ baseUrl: "http://127.0.0.1:41234", started: false })).toContain("http://127.0.0.1:41234/panel");
  });
});
