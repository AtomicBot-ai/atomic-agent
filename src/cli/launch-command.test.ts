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
    issueToken: () => ({ token: "the-run-token", revoke: () => {} }),
    lastingToken: () => ({ token: "the-lasting-token" }),
    findServe: async () => SERVE,
    checkKey: async () => true,
    probeLocal: async () => ({ ok: true, modelId: "qwen-local" }),
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

  it("points the CLI at the bare local model by default: /local, the loaded model's name, any folder (ATO-2447)", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const findServe = vi.fn(async () => SERVE);
    const r = await run(["codex"], { spawn, findServe });
    expect(r.code).toBe(0);
    expect(findServe).toHaveBeenCalledWith("/state", null);
    const args = calls[0]?.args ?? [];
    expect(args).toContain('model_providers.atomic.base_url="http://127.0.0.1:41234/local/v1"');
    expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", "qwen-local"]);
    expect(r.err).toContain("on the local model qwen-local");
    expect(r.err).not.toContain("approval");
  });

  it("--model wins over the loaded model's name (ATO-2447)", async () => {
    const { spawn, calls } = fakeSpawn(0);
    await run(["claude", "--model", "mine"], { spawn });
    expect(calls[0]?.env).toMatchObject({ ANTHROPIC_MODEL: "mine" });
  });

  it("--agent keeps the Atomic Agent turn path: serve root, this folder, approval note (ATO-2447)", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const findServe = vi.fn(async () => SERVE);
    const probeLocal = vi.fn();
    const r = await run(["claude", "--agent"], { spawn, findServe, probeLocal });
    expect(r.code).toBe(0);
    expect(findServe).toHaveBeenCalledWith("/state", "/work");
    expect(probeLocal).not.toHaveBeenCalled();
    expect(calls[0]?.env).toMatchObject({ ANTHROPIC_BASE_URL: "http://127.0.0.1:41234" });
    expect(calls[0]?.env?.ANTHROPIC_MODEL).toBeUndefined();
    expect(r.err).toContain("http://127.0.0.1:41234/panel");
  });

  it("a local model that is not running, or a serve without /local, stops before the CLI with what to do (ATO-2447)", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const down = await run(["claude"], { spawn, probeLocal: async () => ({ ok: false, reason: "not_running" }) });
    expect(down.code).toBe(1);
    expect(down.err).toContain("atag models start");
    const old = await run(["claude"], { spawn, probeLocal: async () => ({ ok: false, reason: "no_route" }) });
    expect(old.code).toBe(1);
    expect(old.err).toContain("--agent");
    expect(calls).toHaveLength(0);
  });

  it("--print-key prints only the key, for Claude Code's apiKeyHelper (ATO-2448)", async () => {
    const r = await run(["--print-key"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("the-lasting-token\n");
  });

  it("--config writes the CLI's setting for port 8787 and runs nothing; --revert takes it out (ATO-2448)", async () => {
    const files = new Map<string, string>();
    const configFs = {
      read: (p: string) => files.get(p) ?? null,
      write: (p: string, t: string) => void files.set(p, t),
      exists: (p: string) => files.has(p),
      copy: (a: string, b: string) => void files.set(b, files.get(a) ?? ""),
      remove: (p: string) => void files.delete(p),
    };
    const { spawn, calls } = fakeSpawn(0);
    const over = { spawn, configFs, home: "/home/u", keyCommand: "atag launch --print-key", findServe: async () => SERVE };
    const r = await run(["claude", "--config"], over);
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(0);
    const settings = [...files.entries()].find(([p]) => p.endsWith("settings.json"))?.[1] ?? "";
    expect(JSON.parse(settings).env).toMatchObject({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/local", ANTHROPIC_MODEL: "qwen-local" });
    expect(settings).not.toContain("the-lasting-token");
    expect(settings).not.toContain("the-serve-key");
    expect(r.out).toContain("atag launch claude --revert");
    const back = await run(["claude", "--revert"], over);
    expect(back.code).toBe(0);
    expect([...files.keys()].some((p) => p.endsWith("settings.json"))).toBe(false);
  });

  it("the run token is removed after the CLI exits and after a failed probe (ATO-2451)", async () => {
    const revoke = vi.fn();
    const issueToken = vi.fn(() => ({ token: "the-run-token", revoke }));
    const { spawn } = fakeSpawn(5);
    expect((await run(["claude"], { spawn, issueToken })).code).toBe(5);
    expect(issueToken).toHaveBeenCalledWith("/state", "claude");
    expect(revoke).toHaveBeenCalledTimes(1);
    const probed: string[] = [];
    const down = await run(["claude"], {
      spawn,
      issueToken,
      probeLocal: async (_b, t) => { probed.push(t); return { ok: false, reason: "not_running" }; },
    });
    expect(down.code).toBe(1);
    expect(probed).toEqual(["the-run-token"]);
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("a failed run token falls back to the serve key with a warning (ATO-2451)", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const r = await run(["claude"], { spawn, issueToken: () => ({ error: "locked" }) });
    expect(r.code).toBe(0);
    expect(r.err).toContain("could not make a separate key for Claude Code");
    expect(calls[0]?.env?.ANTHROPIC_AUTH_TOKEN).toBe("the-serve-key");
  });

  it("--config and --print-env together are a usage error (ATO-2448)", async () => {
    expect((await run(["claude", "--config", "--print-env"])).code).toBe(2);
  });

  it("cline runs its auth step, then the CLI; a failed step stops it (ATO-2449)", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const r = await run(["cline"], { spawn });
    expect(r.code).toBe(0);
    expect(calls.map((c) => c.args[0])).toEqual(["auth", "-P"]);
    const failing = fakeSpawn(3);
    const bad = await run(["cline"], { spawn: failing.spawn });
    expect(bad.code).toBe(3);
    expect(failing.calls).toHaveLength(1);
    expect(bad.err).toContain("Cline setup (auth) failed");
  });

  it("--print-env masks the key inside cline's auth step (ATO-2449)", async () => {
    const r = await run(["cline", "--print-env"]);
    expect(r.out).toContain("/usr/local/bin/cline auth -p openai -k");
    expect(r.out).not.toContain("the-lasting-token");
  });

  it("--print-env on Windows masks the key in env and args before quoting (ATO-2758, ATO-2451)", async () => {
    const codex = await run(["codex", "--print-env"], { platform: "win32" });
    expect(codex.out).toContain(`$env:ATOMIC_AGENT_TOKEN = '${MASKED}'`);
    expect(codex.out).not.toContain("the-lasting-token");
    const cline = await run(["cline", "--print-env"], { platform: "win32" });
    expect(cline.out).toContain(`auth -p openai -k '${MASKED}'`);
    expect(cline.out).not.toContain("the-lasting-token");
  });

  it("a missing CLI in a terminal is installed after a yes and then started (ATO-2450)", async () => {
    let installed = false;
    const { spawn, calls } = fakeSpawn(0);
    const r = await run(["codex"], {
      spawn,
      isTTY: () => true,
      ask: async () => { installed = true; return "y"; },
      findBinary: (b) => (b === "npm" ? "/usr/bin/npm" : installed && calls.length > 0 ? `/usr/local/bin/${b}` : null),
    });
    expect(r.code).toBe(0);
    expect(calls.map((c) => c.cmd)).toEqual(["/usr/bin/npm", "/usr/local/bin/codex"]);
    expect(calls[0]?.args).toEqual(["install", "-g", "@openai/codex"]);
  });
});
