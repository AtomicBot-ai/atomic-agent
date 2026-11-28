import { describe, expect, it, vi } from "vitest";

import { MASKED } from "./launch-command.js";
import { fakeSpawn, run, SERVE } from "./launch-command-test-helpers.js";

describe("atag launch: local model, key, config, run token, setup step and install (ATO-2447 to ATO-2451)", () => {
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
