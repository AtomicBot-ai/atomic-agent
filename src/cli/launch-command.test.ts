import { EventEmitter } from "node:events";
import type { spawn as nodeSpawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { launchCommand, MASKED, parseLaunchArgs, type LaunchCommandDeps } from "./launch-command.js";
import type { LaunchServe } from "./launch-serve.js";

const SERVE: LaunchServe = { baseUrl: "http://127.0.0.1:41234", port: 41234, started: false };

function fakeSpawn(exitCode: number | null, signal: NodeJS.Signals | null = null) {
  const calls: { cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const spawn = ((cmd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, env: options.env });
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
    child.kill = () => true;
    setImmediate(() => child.emit("exit", exitCode, signal));
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn, calls };
}

async function run(args: string[], over: LaunchCommandDeps = {}) {
  let out = "";
  let err = "";
  const deps: LaunchCommandDeps = {
    write: (t) => { out += t; },
    writeErr: (t) => { err += t; },
    stateDir: () => "/state",
    cwd: () => "/work",
    env: { PATH: "/bin" },
    findBinary: (b) => `/usr/local/bin/${b}`,
    resolveKey: () => ({ key: "the-serve-key" }),
    findServe: async () => SERVE,
    checkKey: async () => true,
    platform: "darwin",
    ...over,
  };
  const code = await launchCommand(args, deps);
  return { code, out, err };
}

describe("atag launch (ATO-2172)", () => {
  it("parses the agent, --model and the args after --", () => {
    const parsed = parseLaunchArgs(["codex", "--model", "qwen", "--", "exec", "--json"]);
    expect(parsed).toMatchObject({ model: "qwen", printEnv: false, extraArgs: ["exec", "--json"] });
    expect(parseLaunchArgs(["nope"])).toEqual({ error: expect.stringContaining("unknown agent nope") });
    expect(parseLaunchArgs([])).toEqual({ error: "missing agent name" });
    expect(parseLaunchArgs(["claude", "--help"])).toBe("help");
  });

  it("a missing binary exits 1 with the install hint and starts no serve", async () => {
    const startServe = vi.fn();
    const findServe = vi.fn();
    const r = await run(["claude"], { findBinary: () => null, startServe, findServe });
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
    expect(r.out).toContain("export ANTHROPIC_BASE_URL=http://127.0.0.1:41234");
    expect(r.out).toContain(`export ANTHROPIC_AUTH_TOKEN='${MASKED}'`);
    expect(r.out).not.toContain("the-serve-key");
    expect(r.err).not.toContain("the-serve-key");
    expect(calls).toHaveLength(0);
    expect(startServe).not.toHaveBeenCalled();
  });

  it("--print-env for codex masks the token variable too", async () => {
    const r = await run(["codex", "--print-env"]);
    expect(r.out).toContain(`export ATOMIC_AGENT_TOKEN='${MASKED}'`);
    expect(r.out).not.toContain("the-serve-key");
    expect(r.out).toContain("/usr/local/bin/codex -c");
  });

  it("--print-env on Windows prints PowerShell lines by default, and --shell picks another (ATO-2758)", async () => {
    const win = await run(["claude", "--print-env"], { platform: "win32" });
    expect(win.out).toContain("$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:41234'");
    expect(win.out).toContain(`$env:ANTHROPIC_AUTH_TOKEN = '${MASKED}'`);
    expect(win.out).not.toContain("export ");
    const cmd = await run(["claude", "--print-env", "--shell", "cmd"], { platform: "win32" });
    expect(cmd.out).toContain('set "ANTHROPIC_BASE_URL=http://127.0.0.1:41234"');
    const posix = await run(["claude", "--print-env", "--shell=posix"], { platform: "win32" });
    expect(posix.out).toContain("export ANTHROPIC_BASE_URL=http://127.0.0.1:41234");
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
      ANTHROPIC_BASE_URL: "http://127.0.0.1:41234",
      ANTHROPIC_AUTH_TOKEN: "the-serve-key",
    });
    expect(r.err).not.toContain("the-serve-key");
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
    const r = await run(["claude"], { spawn, checkKey: async () => false });
    expect(r.code).toBe(1);
    expect(r.err).toContain("does not accept the key");
    expect(calls).toHaveLength(0);
  });

  it("an unknown agent is a usage error", async () => {
    const r = await run(["gemini"]);
    expect(r.code).toBe(2);
  });
});
