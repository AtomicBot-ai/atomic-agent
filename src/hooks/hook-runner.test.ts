import { describe, expect, it } from "vitest";
import { runHookCommand } from "./hook-runner.js";
import type { HookCommand } from "./hook-types.js";

const posix = process.platform !== "win32";
const cmd = (command: string, timeoutMs = 10_000): HookCommand => ({ type: "command", command, timeoutMs, source: { kind: "user", file: "/s/hooks.json" } });

describe.skipIf(!posix)("hook runner", () => {
  it("passes JSON on stdin and returns stdout and the exit code", async () => {
    const r = await runHookCommand(cmd("cat; exit 3"), { tool_name: "Bash" }, { cwd: process.cwd() });
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stdout)).toEqual({ tool_name: "Bash" });
    expect(r.timedOut).toBe(false);
  });

  it("kills a hanging hook at its timeout and says so", async () => {
    const started = Date.now();
    const r = await runHookCommand(cmd("sleep 30", 300), {}, { cwd: process.cwd() });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not pass provider keys to the hook", async () => {
    const r = await runHookCommand(cmd("echo \"[$OPENROUTER_API_KEY][$KEEP_ME]\""), {}, {
      cwd: process.cwd(),
      baseEnv: { PATH: process.env.PATH, OPENROUTER_API_KEY: "sk-secret", KEEP_ME: "yes" },
    });
    expect(r.stdout.trim()).toBe("[][yes]");
  });

  it("sets the plugin variables for plugin hooks", async () => {
    const hook: HookCommand = { type: "command", command: "echo \"$CLAUDE_PLUGIN_ROOT\"", timeoutMs: 10_000, source: { kind: "plugin", plugin: "p", root: "/plug/root", data: "/plug/data" } };
    const r = await runHookCommand(hook, {}, { cwd: process.cwd() });
    expect(r.stdout.trim()).toBe("/plug/root");
  });

  it("stops when the turn is cancelled", async () => {
    const ac = new AbortController();
    const p = runHookCommand(cmd("sleep 30"), {}, { cwd: process.cwd(), signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.spawnError).toBe("cancelled");
  });
});
