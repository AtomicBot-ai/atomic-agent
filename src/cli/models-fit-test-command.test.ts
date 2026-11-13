import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { callOnce, parseFitTestArgs, runRestoringOnStop } from "./models-fit-test-command.js";

describe("parseFitTestArgs", () => {
  it("reads the flags", () => {
    const parsed = parseFitTestArgs([
      "--tasks", "t.json", "--models", "a, b,a", "--judge-url", "http://127.0.0.1:8080",
      "--judge-key-env", "JUDGE_KEY", "--timeout", "60", "--json",
    ]);
    expect(parsed).toMatchObject({
      modelIds: ["a", "b"],
      judgeUrl: "http://127.0.0.1:8080",
      judgeModel: "judge",
      judgeKeyEnv: "JUDGE_KEY",
      timeoutMs: 60_000,
      outPath: null,
      json: true,
    });
  });

  it("requires a task file, models and a judge, and caps the models at three", () => {
    expect(parseFitTestArgs(["--models", "a", "--judge-url", "u"])).toMatchObject({ error: expect.stringMatching(/--tasks/) });
    expect(parseFitTestArgs(["--tasks", "t", "--judge-url", "u"])).toMatchObject({ error: expect.stringMatching(/--models/) });
    expect(parseFitTestArgs(["--tasks", "t", "--models", "a"])).toMatchObject({ error: expect.stringMatching(/--judge-url/) });
    expect(parseFitTestArgs(["--tasks", "t", "--models", "a,b,c,d", "--judge-url", "u"])).toMatchObject({ error: expect.stringMatching(/at most 3/) });
    expect(parseFitTestArgs(["--tasks", "t", "--models", "a", "--judge-url", "u", "--timeout", "0"])).toMatchObject({ error: expect.stringMatching(/--timeout/) });
  });
});

/** A run that ends only when its signal is aborted, like a child killed by the stop. */
function runUntilAborted(signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => signal.addEventListener("abort", () => setTimeout(() => resolve("partial"), 5), { once: true }));
}

describe("runRestoringOnStop (ATO-1498)", () => {
  it("restores once after a normal run and removes its listeners", async () => {
    const target = new EventEmitter();
    const restore = vi.fn(async (_stopped: boolean) => {});
    const exit = vi.fn();
    const outcome = await runRestoringOnStop(async () => "done", restore, { target, exit, write: () => {} });
    expect(outcome).toEqual({ stoppedBy: null, result: "done" });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(false);
    expect(exit).not.toHaveBeenCalled();
    expect(target.listenerCount("SIGINT") + target.listenerCount("SIGTERM")).toBe(0);
  });

  it("restores and rethrows when the run fails", async () => {
    const restore = vi.fn(async (_stopped: boolean) => {});
    await expect(
      runRestoringOnStop(async () => Promise.reject(new Error("boom")), restore, { target: new EventEmitter(), exit: vi.fn(), write: () => {} }),
    ).rejects.toThrow("boom");
    expect(restore).toHaveBeenCalledWith(false);
  });

  it("on SIGTERM stops the run, restores once and reports exit code 143", async () => {
    const target = new EventEmitter();
    const order: string[] = [];
    const restore = vi.fn(async (stopped: boolean) => void order.push(`restore:${String(stopped)}`));
    const exit = vi.fn();
    let seen: AbortSignal | null = null;
    const pending = runRestoringOnStop(
      async (signal) => {
        seen = signal;
        const reply = await runUntilAborted(signal);
        order.push("run settled");
        return reply;
      },
      restore,
      { target, exit, write: () => {}, graceMs: 10_000 },
    );
    target.emit("SIGTERM");
    const outcome = await pending;
    expect(outcome).toEqual({ stoppedBy: "SIGTERM", exitCode: 143 });
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    // The child is stopped (and its temp dirs removed) before the model goes back.
    expect(order).toEqual(["run settled", "restore:true"]);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(target.listenerCount("SIGINT") + target.listenerCount("SIGTERM")).toBe(0);
  });

  it("reports 130 for SIGINT and quits at once on a second signal", async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    const pending = runRestoringOnStop(runUntilAborted, async () => {}, { target, exit, write: () => {}, graceMs: 10_000 });
    target.emit("SIGINT");
    target.emit("SIGINT");
    expect(exit).toHaveBeenCalledWith(130);
    expect(await pending).toEqual({ stoppedBy: "SIGINT", exitCode: 130 });
  });

  it("restores and exits when the run does not stop within the grace, without restoring twice", async () => {
    const target = new EventEmitter();
    const restore = vi.fn(async (_stopped: boolean) => {});
    let finish: (value: string) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      const pending = runRestoringOnStop(
        () => new Promise<string>((resolve) => (finish = resolve)),
        restore,
        { target, exit: resolve, write: () => {}, graceMs: 5 },
      );
      void pending.then((outcome) => expect(outcome).toEqual({ stoppedBy: "SIGTERM", exitCode: 143 }));
    });
    target.emit("SIGTERM");
    expect(await exited).toBe(143);
    expect(restore).toHaveBeenCalledWith(true);
    finish("late");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(restore).toHaveBeenCalledTimes(1);
  });
});

describe("runRestoringOnStop after the run settled (ATO-1498)", () => {
  it("a signal during the normal restore does not leave a timer that exits later", async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    const restore = vi.fn(async (_stopped: boolean) => void target.emit("SIGTERM"));
    const outcome = await runRestoringOnStop(async () => "done", restore, { target, exit, write: () => {}, graceMs: 5 });
    expect(outcome).toEqual({ stoppedBy: null, result: "done" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exit).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(target.listenerCount("SIGINT") + target.listenerCount("SIGTERM")).toBe(0);
  });
});

describe("callOnce", () => {
  it("runs the function once and hands later calls the same promise", async () => {
    const fn = vi.fn(async (_x: number) => {});
    const wrapped = callOnce(fn);
    const a = wrapped(1);
    const b = wrapped(2);
    expect(a).toBe(b);
    await a;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });
});
