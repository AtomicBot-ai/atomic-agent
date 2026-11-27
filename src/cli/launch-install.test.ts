import { EventEmitter } from "node:events";
import type { spawn as nodeSpawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { findLaunchIntegration } from "./launch-integrations.js";
import { findLaunchBinary, installCommandLine, offerInstall, type InstallDeps } from "./launch-install.js";

/** ATO-2450: offer to install a missing CLI, only after a yes in a terminal. */

function fakeSpawn(exitCode: number, onRun: () => void = () => undefined) {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const spawn = ((cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
    child.kill = () => true;
    setImmediate(() => {
      onRun();
      child.emit("exit", exitCode, null);
    });
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn, calls };
}

const claude = findLaunchIntegration("claude");
if (!claude) throw new Error("no claude integration");

function deps(over: Partial<InstallDeps> & { installed?: () => boolean } = {}): { deps: InstallDeps; err: () => string } {
  let err = "";
  const installed = over.installed ?? (() => false);
  return {
    deps: {
      isTTY: () => true,
      ask: async () => "y",
      findBinary: (b) => (b === "npm" ? "/usr/bin/npm" : installed() ? `/usr/local/bin/${b}` : null),
      spawn: fakeSpawn(0).spawn,
      env: {},
      writeErr: (t) => { err += t; },
      ...over,
    },
    err: () => err,
  };
}

describe("offerInstall", () => {
  it("shows the exact command, runs npm after a yes, and hands back the new binary", async () => {
    let done = false;
    const { spawn, calls } = fakeSpawn(0, () => { done = true; });
    let question = "";
    const d = deps({ spawn, installed: () => done, ask: async (q) => { question = q; return "yes"; } });
    const r = await offerInstall(claude, d.deps);
    expect(question).toContain("npm install -g @anthropic-ai/claude-code");
    expect(calls).toEqual([{ cmd: "/usr/bin/npm", args: ["install", "-g", "@anthropic-ai/claude-code"] }]);
    expect(r).toEqual({ path: "/usr/local/bin/claude" });
  });

  it("anything but yes installs nothing", async () => {
    for (const answer of ["", "n", "no", "sure"]) {
      const { spawn, calls } = fakeSpawn(0);
      const d = deps({ spawn, ask: async () => answer });
      expect(await offerInstall(claude, d.deps)).toEqual({ code: 1 });
      expect(calls).toHaveLength(0);
      expect(d.err()).toContain("To install it yourself: npm install -g @anthropic-ai/claude-code");
    }
  });

  it("without a terminal it never asks and never installs", async () => {
    const { spawn, calls } = fakeSpawn(0);
    let asked = false;
    const d = deps({ spawn, isTTY: () => false, ask: async () => { asked = true; return "y"; } });
    expect(await offerInstall(claude, d.deps)).toEqual({ code: 1 });
    expect(asked).toBe(false);
    expect(calls).toHaveLength(0);
    expect(d.err()).toContain("Install it with: npm install -g @anthropic-ai/claude-code");
  });

  it("without npm it says to install Node.js first and asks nothing", async () => {
    let asked = false;
    const d = deps({ findBinary: () => null, ask: async () => { asked = true; return "y"; } });
    expect(await offerInstall(claude, d.deps)).toEqual({ code: 1 });
    expect(asked).toBe(false);
    expect(d.err()).toContain("https://nodejs.org");
  });

  it("a failed install passes npm's exit code on; installed but not on PATH says to open a new terminal", async () => {
    const failed = deps({ spawn: fakeSpawn(243).spawn });
    expect(await offerInstall(claude, failed.deps)).toEqual({ code: 243 });
    const hidden = deps({ spawn: fakeSpawn(0).spawn, installed: () => false });
    expect(await offerInstall(claude, hidden.deps)).toEqual({ code: 1 });
    expect(hidden.err()).toContain("Open a new terminal");
  });

  it("every integration has an install command matching its hint", () => {
    for (const id of ["claude", "codex", "opencode", "qwen", "cline"]) {
      const i = findLaunchIntegration(id);
      expect(i && installCommandLine(i)).toBe(i?.installHint);
    }
  });
});

describe("findLaunchBinary", () => {
  it("on Windows takes claude.cmd over the extensionless shell shim npm also leaves", () => {
    const onPath = new Set(["C:\\npm\\claude", "C:\\npm\\claude.cmd"]);
    const find = ((name: string) => {
      const path = `C:\\npm\\${name}`;
      return onPath.has(path) ? path : null;
    }) as never;
    expect(findLaunchBinary("claude", {}, "win32", find)).toBe("C:\\npm\\claude.cmd");
    expect(findLaunchBinary("claude", {}, "darwin", find)).toBe("C:\\npm\\claude");
  });
});
