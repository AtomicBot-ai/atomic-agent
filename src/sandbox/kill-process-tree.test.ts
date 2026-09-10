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
  const started: EventEmitter[] = [];
  const impl = ((file: string, args: readonly string[]) => {
    calls.push({ file, args });
    if (mode === "throw") throw new Error("EPERM");
    const emitter = new EventEmitter();
    started.push(emitter);
    if (mode === "error-event") {
      queueMicrotask(() => emitter.emit("error", new Error("ENOENT")));
    }
    return emitter;
  }) as unknown as typeof import("node:child_process").spawn;
  return { calls, impl, started };
}

/** Collects what the caller is told about the descendants. */
function outcome() {
  const reported: boolean[] = [];
  return { reported, onTreeKilled: (killed: boolean) => reported.push(killed) };
}

describe("killProcessTree on posix", () => {
  it("signals the child directly", () => {
    const { child, signals } = fakeChild(4242);
    const { calls, impl } = fakeSpawn();
    const { reported, onTreeKilled } = outcome();
    killProcessTree(child, {
      platform: "darwin",
      spawnImpl: impl,
      onTreeKilled,
    });
    killProcessTree(child, { platform: "linux", force: true, spawnImpl: impl });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(calls).toEqual([]);
    // There is no tree here: the child *is* the process we mean.
    expect(reported).toEqual([true]);
  });
});

describe("killProcessTree on win32", () => {
  it("walks the tree with taskkill instead of TerminateProcess on one pid", () => {
    // The whole reason this exists: with a `cmd.exe` wrapper the real
    // CLI is a *grandchild*, and `child.kill` would leave it running.
    const { child, signals } = fakeChild(4242);
    const { calls, impl } = fakeSpawn();
    killProcessTree(child, { platform: "win32", spawnImpl: impl });
    expect(calls).toEqual([{ file: "taskkill", args: ["/PID", "4242", "/T"] }]);
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
    expect(() => killProcessTree(child, { platform: "darwin" })).not.toThrow();
  });
});

/**
 * `taskkill` without `/F` posts WM_CLOSE, and a console process spawned
 * with `windowsHide: true` has no window to receive it: taskkill answers
 * "This process can only be terminated forcefully (with /F option)" and
 * exits non-zero. With `stdio: "ignore"` and nobody watching `close`,
 * that refusal was invisible and the polite pass silently did nothing.
 */
describe("a taskkill that refuses", () => {
  it("is escalated to /F rather than reported as done", () => {
    const { child, signals } = fakeChild(4242);
    const { calls, impl, started } = fakeSpawn();
    const { reported, onTreeKilled } = outcome();
    killProcessTree(child, {
      platform: "win32",
      spawnImpl: impl,
      onTreeKilled,
    });

    started[0]?.emit("close", 1);
    expect(calls.map((call) => call.args)).toEqual([
      ["/PID", "4242", "/T"],
      ["/PID", "4242", "/T", "/F"],
    ]);
    // Nothing is claimed until the escalation itself answers.
    expect(reported).toEqual([]);
    expect(signals).toEqual([]);

    started[1]?.emit("close", 0);
    expect(reported).toEqual([true]);
  });

  it("gives up on the direct child when even /F is refused", () => {
    const { child, signals } = fakeChild(4242);
    const { impl, started } = fakeSpawn();
    const { reported, onTreeKilled } = outcome();
    killProcessTree(child, {
      platform: "win32",
      spawnImpl: impl,
      onTreeKilled,
    });
    started[0]?.emit("close", 1);
    started[1]?.emit("close", 1);
    expect(signals).toEqual(["SIGKILL"]);
    // TerminateProcess at the wrapper leaves the grandchild: say so.
    expect(reported).toEqual([false]);
  });

  it("does not re-run taskkill at a pid that is already gone", () => {
    // Exit 128 is "no such process" — there is nothing left to kill, and
    // a second pass with /F could reach whatever Windows gave the pid to
    // next.
    const { child, signals } = fakeChild(4242);
    const { calls, impl, started } = fakeSpawn();
    const { reported, onTreeKilled } = outcome();
    killProcessTree(child, {
      platform: "win32",
      spawnImpl: impl,
      onTreeKilled,
    });
    started[0]?.emit("close", 128);
    expect(calls).toHaveLength(1);
    expect(signals).toEqual([]);
    expect(reported).toEqual([true]);
  });

  it("reports a fallback as a fallback", () => {
    const { child } = fakeChild(4242);
    const { impl } = fakeSpawn("throw");
    const { reported, onTreeKilled } = outcome();
    killProcessTree(child, {
      platform: "win32",
      spawnImpl: impl,
      onTreeKilled,
    });
    expect(reported).toEqual([false]);
  });

  it("reports a missing pid as a fallback too", () => {
    const { child } = fakeChild(undefined);
    const { impl } = fakeSpawn();
    const { reported, onTreeKilled } = outcome();
    killProcessTree(child, {
      platform: "win32",
      spawnImpl: impl,
      onTreeKilled,
    });
    expect(reported).toEqual([false]);
  });
});
