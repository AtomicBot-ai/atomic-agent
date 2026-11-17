import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  createKeepAwake,
  holdWhileRunning,
  inhibitorCommand,
  parseKeepAwakeMode,
} from "./keep-awake.js";

/** A stand-in for the inhibitor process: records kills, emits on demand. */
class FakeChild extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  unref(): void {}
}

function fakeSpawn() {
  const children: FakeChild[] = [];
  const calls: { command: string; args: string[] }[] = [];
  const spawn = vi.fn((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  return { spawn, children, calls };
}

describe("parseKeepAwakeMode", () => {
  it("reads the two modes and a few spellings of them", () => {
    expect(parseKeepAwakeMode("off")).toBe("off");
    expect(parseKeepAwakeMode("while-working")).toBe("while-working");
    expect(parseKeepAwakeMode(" While_Working ")).toBe("while-working");
    expect(parseKeepAwakeMode("on")).toBe("while-working");
  });

  it("rejects the removed always mode", () => {
    expect(parseKeepAwakeMode("always")).toBeNull();
    expect(parseKeepAwakeMode("ALWAYS")).toBeNull();
  });

  it("is null for empty or unknown values", () => {
    expect(parseKeepAwakeMode(undefined)).toBeNull();
    expect(parseKeepAwakeMode(null)).toBeNull();
    expect(parseKeepAwakeMode("  ")).toBeNull();
    expect(parseKeepAwakeMode("forever")).toBeNull();
  });
});

describe("inhibitorCommand", () => {
  it("uses caffeinate tied to our pid on macOS", () => {
    expect(inhibitorCommand("darwin", 42)).toEqual({
      command: "caffeinate",
      args: ["-i", "-w", "42"],
    });
  });

  it("uses systemd-inhibit around a pid watcher on Linux", () => {
    const cmd = inhibitorCommand("linux", 42);
    expect(cmd?.command).toBe("systemd-inhibit");
    expect(cmd?.args).toContain("--what=idle:sleep");
    expect(cmd?.args.slice(-4)).toEqual(["tail", "--pid=42", "-f", "/dev/null"]);
  });

  it("has nothing on Windows", () => {
    expect(inhibitorCommand("win32", 42)).toBeNull();
  });
});

describe("createKeepAwake", () => {
  it("off never starts an inhibitor", () => {
    const { spawn } = fakeSpawn();
    const ka = createKeepAwake({ mode: "off", platform: "darwin", pid: 1, spawn });
    const release = ka.hold();
    expect(ka.active).toBe(false);
    release();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("while-working holds nothing until work starts", () => {
    const { spawn } = fakeSpawn();
    const ka = createKeepAwake({ mode: "while-working", platform: "darwin", pid: 1, spawn });
    expect(spawn).not.toHaveBeenCalled();
    expect(ka.active).toBe(false);
  });

  it("while-working holds one inhibitor across overlapping drains and drops it after the last", () => {
    const { spawn, children, calls } = fakeSpawn();
    const ka = createKeepAwake({ mode: "while-working", platform: "darwin", pid: 7, spawn });
    expect(spawn).not.toHaveBeenCalled();

    const a = ka.hold();
    const b = ka.hold();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({ command: "caffeinate", args: ["-i", "-w", "7"] });
    expect(ka.active).toBe(true);

    a();
    a(); // a second release of the same hold is ignored
    expect(children[0]!.killed).toBe(false);
    b();
    expect(children[0]!.killed).toBe(true);
    expect(ka.active).toBe(false);

    const c = ka.hold();
    expect(spawn).toHaveBeenCalledTimes(2);
    c();
    expect(children[1]!.killed).toBe(true);
  });

  it("does nothing on Windows", () => {
    const { spawn } = fakeSpawn();
    const ka = createKeepAwake({ mode: "while-working", platform: "win32", pid: 7, spawn });
    ka.hold();
    expect(spawn).not.toHaveBeenCalled();
    expect(ka.active).toBe(false);
  });

  it("stops trying after the tool is missing, with one warning", () => {
    const { spawn, children } = fakeSpawn();
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn } as never;
    const ka = createKeepAwake({ mode: "while-working", platform: "linux", pid: 7, spawn, logger });
    const release = ka.hold();
    children[0]!.emit("error", Object.assign(new Error("spawn systemd-inhibit ENOENT"), { code: "ENOENT" }));
    expect(ka.active).toBe(false);
    release();
    ka.hold()();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stops trying when the tool exits on its own (refused)", () => {
    const { spawn, children } = fakeSpawn();
    const ka = createKeepAwake({ mode: "while-working", platform: "linux", pid: 7, spawn });
    const release = ka.hold();
    children[0]!.emit("exit", 1);
    release();
    ka.hold()();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("an exit after our own kill does not count as a refusal", () => {
    const { spawn, children } = fakeSpawn();
    const ka = createKeepAwake({ mode: "while-working", platform: "darwin", pid: 7, spawn });
    ka.hold()();
    children[0]!.emit("exit", null);
    ka.hold()();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("a spawn that throws is treated as unavailable", () => {
    const spawn = vi.fn(() => {
      throw new Error("EPERM");
    });
    const ka = createKeepAwake({ mode: "while-working", platform: "darwin", pid: 7, spawn });
    expect(() => ka.hold()()).not.toThrow();
    ka.hold()();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("holdWhileRunning (a turn holds the keep-awake)", () => {
  it("holds only while the turn runs and releases after it settles", async () => {
    const { spawn, children } = fakeSpawn();
    const ka = createKeepAwake({ mode: "while-working", platform: "darwin", pid: 7, spawn });
    let finish: (v: string) => void = () => {};
    const turn = holdWhileRunning(ka, (msg: string) =>
      new Promise<string>((resolve) => { finish = (v) => resolve(`${msg}:${v}`); }),
    );
    expect(ka.active).toBe(false);
    const p = turn("hi");
    expect(ka.active).toBe(true);
    finish("done");
    await expect(p).resolves.toBe("hi:done");
    expect(ka.active).toBe(false);
    expect(children[0]!.killed).toBe(true);
  });

  it("releases when the turn throws", async () => {
    const { spawn } = fakeSpawn();
    const ka = createKeepAwake({ mode: "while-working", platform: "darwin", pid: 7, spawn });
    const turn = holdWhileRunning(ka, async () => {
      throw new Error("boom");
    });
    await expect(turn()).rejects.toThrow("boom");
    expect(ka.active).toBe(false);
  });

  it("default config (off): a turn never starts a blocker", async () => {
    const { spawn } = fakeSpawn();
    const ka = createKeepAwake({ mode: "off", platform: "darwin", pid: 7, spawn });
    await holdWhileRunning(ka, async () => "ok")();
    expect(spawn).not.toHaveBeenCalled();
  });
});
