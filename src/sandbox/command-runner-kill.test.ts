import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `runCommand` is the highest-traffic caller of the shared tree-kill —
 * every `run_test`, every bit of git plumbing — and its stop path had no
 * coverage at all: replacing `killProcessTree(child, { force: true })`
 * with a bare `child.kill("SIGKILL")` (and dropping the now-unused
 * import) compiled and left the suite green, because on this host the
 * two do the same thing. The helper exists for Windows, where they do
 * not: `child.kill` is `TerminateProcess` at one pid and leaves a
 * subshell's descendants running. So the call itself is what is pinned
 * here, alongside the behaviour it has to keep on POSIX.
 *
 * The real implementation still runs — the spy only watches — so the
 * children in these tests actually die.
 */
const { killSpy } = vi.hoisted(() => ({ killSpy: vi.fn() }));

vi.mock("./kill-process-tree.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./kill-process-tree.js")>();
  return {
    ...actual,
    killProcessTree: (
      child: Parameters<typeof actual.killProcessTree>[0],
      options?: Parameters<typeof actual.killProcessTree>[1],
    ) => {
      killSpy(options);
      actual.killProcessTree(child, options);
    },
  };
});

const { runCommand } = await import("./command-runner.js");

let dir = "";

/**
 * Traps SIGTERM and keeps running, so only a forceful stop ends it: a
 * polite one would hang this test rather than quietly pass it.
 */
function stubbornChild(readyFile: string) {
  return [
    "-e",
    `
      process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, "1");
      setInterval(() => {}, 1000);
    `,
  ];
}

async function waitForReady(readyFile: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (existsSync(readyFile)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("child never signalled ready");
}

beforeEach(() => {
  killSpy.mockClear();
  dir = mkdtempSync(join(tmpdir(), "runner-kill-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("runCommand stopping a child", () => {
  it("goes through the tree-kill on abort, forcefully", async () => {
    const ready = join(dir, "ready-abort");
    const controller = new AbortController();
    const pending = runCommand(process.execPath, stubbornChild(ready), {
      cwd: process.cwd(),
      timeoutMs: 0,
      signal: controller.signal,
    });

    await waitForReady(ready);
    controller.abort();
    const result = await pending;

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith({ force: true });
    expect(result.signal).toBe("SIGKILL");
    expect(result.timedOut).toBe(false);
  });

  it("goes through it on timeout too", async () => {
    const ready = join(dir, "ready-timeout");
    const result = await runCommand(process.execPath, stubbornChild(ready), {
      cwd: process.cwd(),
      timeoutMs: 400,
    });

    expect(killSpy).toHaveBeenCalledWith({ force: true });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });

  it("does not reach for it when the command ends on its own", async () => {
    const result = await runCommand(process.execPath, ["-e", "0"], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
