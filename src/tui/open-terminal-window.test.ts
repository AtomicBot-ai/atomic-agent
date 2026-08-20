import { describe, it, expect, vi } from "vitest";

import {
  openAgentTerminalWindow,
  openTerminalWindow,
  isOnPath,
  type SpawnedTerminal,
  type TerminalSpawn,
} from "./open-terminal-window.js";
import type { TerminalLaunchInput } from "./build-terminal-launch.js";

/** Child stub that replays one lifecycle event on `once`. */
function fakeChild(
  event: "spawn" | "error" | "exit" | "none",
  payload?: Error | number,
) {
  const unref = vi.fn();
  const child: SpawnedTerminal = {
    once(name: string, listener: (...args: never[]) => void) {
      if (name === event) {
        // Deliver asynchronously, like the real emitter.
        queueMicrotask(() =>
          (listener as unknown as (arg?: Error | number) => void)(payload),
        );
      }
      return child;
    },
    unref,
  };
  return { child, unref };
}

const LAUNCH = { cmd: "osascript", args: ["-e", "…"], label: "Terminal" };

describe("openTerminalWindow", () => {
  it("reports success when the launcher exits 0, detached and unref'd", async () => {
    const { child, unref } = fakeChild("exit", 0);
    const spawn = vi.fn(() => child) as unknown as TerminalSpawn;
    const result = await openTerminalWindow(LAUNCH, { cwd: "/w", spawn });
    expect(result).toEqual({ ok: true, label: "Terminal" });
    expect(spawn).toHaveBeenCalledWith("osascript", ["-e", "…"], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      cwd: "/w",
    });
    // Detached + unref'd: quitting this agent must not kill the new window.
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("treats a launcher that keeps running as an open window", async () => {
    // Direct emulators (xterm, kitty) live as long as the window itself.
    const { child, unref } = fakeChild("none");
    const spawn = vi.fn(() => child) as unknown as TerminalSpawn;
    const result = await openTerminalWindow(LAUNCH, { spawn, settleMs: 10 });
    expect(result).toEqual({ ok: true, label: "Terminal" });
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("reports a launcher that spawned fine and then failed", async () => {
    // The osascript shape: process starts, AppleScript errors, exit 1 —
    // the old spawn-event reading called this "opened".
    const { child, unref } = fakeChild("exit", 1);
    const spawn = vi.fn(() => child) as unknown as TerminalSpawn;
    const result = await openTerminalWindow(LAUNCH, { spawn });
    expect(result).toEqual({
      ok: false,
      reason: "osascript exited with 1",
    });
    expect(unref).not.toHaveBeenCalled();
  });

  it("returns the spawn error instead of throwing", async () => {
    const { child } = fakeChild("error", new Error("spawn osascript ENOENT"));
    const spawn = vi.fn(() => child) as unknown as TerminalSpawn;
    const result = await openTerminalWindow(LAUNCH, { spawn });
    expect(result).toEqual({
      ok: false,
      reason: "osascript: spawn osascript ENOENT",
    });
  });

  it("survives a synchronous throw from spawn", async () => {
    const spawn = vi.fn(() => {
      throw new Error("EACCES");
    }) as unknown as TerminalSpawn;
    const result = await openTerminalWindow(LAUNCH, { spawn });
    expect(result).toEqual({ ok: false, reason: "osascript: EACCES" });
  });
});

describe("openAgentTerminalWindow", () => {
  const base: TerminalLaunchInput = {
    platform: "linux",
    execPath: "/usr/bin/node",
    argv: ["/usr/bin/node", "/opt/a.js"],
    isSea: false,
    cwd: "/w",
    env: {},
    hasBinary: () => false,
  };

  it("explains itself when the box has no terminal emulator", async () => {
    const spawn = vi.fn() as unknown as TerminalSpawn;
    const result = await openAgentTerminalWindow(base, { spawn });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      "ATOMIC_AGENT_TERMINAL",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns the resolved emulator in the working directory", async () => {
    const { child } = fakeChild("spawn");
    const spawn = vi.fn(() => child) as unknown as TerminalSpawn;
    const result = await openAgentTerminalWindow(
      { ...base, hasBinary: (n) => n === "xterm" },
      { spawn },
    );
    expect(result).toEqual({ ok: true, label: "xterm" });
    expect(spawn).toHaveBeenCalledWith(
      "xterm",
      expect.arrayContaining(["-e", "sh", "-c"]),
      expect.objectContaining({ cwd: "/w", detached: true }),
    );
  });
});

describe("isOnPath", () => {
  it("finds a binary that exists on PATH", () => {
    expect(isOnPath("sh", { PATH: "/nope:/bin:/usr/bin" })).toBe(true);
  });

  it("misses one that does not", () => {
    expect(isOnPath("definitely-not-a-real-binary", { PATH: "/bin" })).toBe(false);
  });

  it("treats an empty PATH as a miss rather than an error", () => {
    expect(isOnPath("sh", {})).toBe(false);
  });
});
