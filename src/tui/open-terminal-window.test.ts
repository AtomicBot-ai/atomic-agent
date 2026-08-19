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
function fakeChild(event: "spawn" | "error", error?: Error) {
  const unref = vi.fn();
  const child: SpawnedTerminal = {
    once(name: string, listener: (...args: never[]) => void) {
      if (name === event) {
        // Deliver asynchronously, like the real emitter.
        queueMicrotask(() =>
          (listener as unknown as (arg?: Error) => void)(error),
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
  it("spawns detached, unrefs, and reports the terminal name", async () => {
    const { child, unref } = fakeChild("spawn");
    const spawn = vi.fn(() => child) as unknown as TerminalSpawn;
    const result = await openTerminalWindow(LAUNCH, { cwd: "/w", spawn });
    expect(result).toEqual({ ok: true, label: "Terminal" });
    expect(spawn).toHaveBeenCalledWith("osascript", ["-e", "…"], {
      detached: true,
      stdio: "ignore",
      cwd: "/w",
    });
    // Detached + unref'd: quitting this agent must not kill the new window.
    expect(unref).toHaveBeenCalledTimes(1);
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
