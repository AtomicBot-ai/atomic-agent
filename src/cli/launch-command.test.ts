import { EventEmitter } from "node:events";
import type { spawn as nodeSpawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { launchApprovalNote, launchCommand, MASKED, parseLaunchArgs, type LaunchCommandDeps } from "./launch-command.js";
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
    expect(parseLaunchArgs([])).toMatchObject({ integration: null });
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
