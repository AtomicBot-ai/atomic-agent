import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { killProcessTree, type KillableChild } from "./kill-process-tree.js";

function fakeChild(pid?: number) {
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  const child: KillableChild = {
    pid,
    kill(signal) {
      signals.push(signal);
      return true;
    },
  };
  return { child, signals };
}

/** Stands in for a spawned `taskkill`; `fail` makes the spawn itself fail. */
function fakeSpawn(mode: "ok" | "error-event" | "throw" = "ok") {
  const calls: { file: string; args: readonly string[] }[] = [];
  const impl = ((file: string, args: readonly string[]) => {
    calls.push({ file, args });
    if (mode === "throw") throw new Error("EPERM");
    const emitter = new EventEmitter();
    if (mode === "error-event") {
      queueMicrotask(() => emitter.emit("error", new Error("ENOENT")));
    }
    return emitter;
  }) as unknown as typeof import("node:child_process").spawn;
  return { calls, impl };
}

describe("killProcessTree on posix", () => {
  it("signals the child directly", () => {
    const { child, signals } = fakeChild(4242);
    const { calls, impl } = fakeSpawn();
    killProcessTree(child, { platform: "darwin", spawnImpl: impl });
    killProcessTree(child, { platform: "linux", force: true, spawnImpl: impl });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(calls).toEqual([]);
  });
});

describe("killProcessTree on win32", () => {
  it("walks the tree with taskkill instead of TerminateProcess on one pid", () => {
    // The whole reason this exists: with a `cmd.exe` wrapper the real
    // CLI is a *grandchild*, and `child.kill` would leave it running.
    const { child, signals } = fakeChild(4242);
    const { calls, impl } = fakeSpawn();
    killProcessTree(child, { platform: "win32", spawnImpl: impl });
    expect(calls).toEqual([
      { file: "taskkill", args: ["/PID", "4242", "/T"] },
    ]);
    expect(signals).toEqual([]);
  });

  it("adds /F when the polite stop has already been tried", () => {
    const { child } = fakeChild(4242);
    const { calls, impl } = fakeSpawn();
    killProcessTree(child, { platform: "win32", force: true, spawnImpl: impl });
    expect(calls[0]?.args).toEqual(["/PID", "4242", "/T", "/F"]);
  });

  it("falls back to a direct signal when taskkill cannot be spawned", async () => {
    const { child, signals } = fakeChild(4242);
    const { impl } = fakeSpawn("error-event");
    killProcessTree(child, { platform: "win32", force: true, spawnImpl: impl });
    await Promise.resolve();
    expect(signals).toEqual(["SIGKILL"]);
  });

  it("falls back when the spawn throws outright", () => {
    const { child, signals } = fakeChild(4242);
    const { impl } = fakeSpawn("throw");
    killProcessTree(child, { platform: "win32", spawnImpl: impl });
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("falls back when there is no pid to hand taskkill", () => {
    const { child, signals } = fakeChild(undefined);
    const { calls, impl } = fakeSpawn();
    killProcessTree(child, { platform: "win32", spawnImpl: impl });
    expect(calls).toEqual([]);
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("survives a child that has already exited", () => {
    const child: KillableChild = {
      pid: 1,
      kill() {
        throw new Error("ESRCH");
      },
    };
    expect(() =>
      killProcessTree(child, { platform: "darwin" }),
    ).not.toThrow();
  });
});
