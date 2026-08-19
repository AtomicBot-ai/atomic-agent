import { afterEach, describe, expect, it } from "vitest";

import type { CliRunOptions } from "./run-cli-completion.js";
import { streamCliCommand } from "./stream-cli-completion.js";
import {
  SubscriptionCliAuthError,
  SubscriptionCliNotInstalledError,
} from "./subscription-cli-errors.js";

/**
 * These exercise the real spawn/line-splitting path against a scripted
 * node child — never against a vendor CLI. Mocking `child_process`
 * instead would test the mock, not the buffering behaviour that the
 * NDJSON reader actually has to get right.
 */
function options(script: string, extra: Partial<CliRunOptions> = {}): CliRunOptions {
  return {
    binary: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    timeoutMs: 15_000,
    maxOutputBytes: 1024 * 1024,
    installHint: "install it",
    authHint: "log in",
    ...extra,
  };
}

async function collect(opts: CliRunOptions): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of streamCliCommand(opts)) lines.push(line);
  return lines;
}

describe("streamCliCommand", () => {
  it("reassembles lines split across chunk boundaries", async () => {
    // Deliberately writes half a JSON object, pauses, then the rest.
    const script = `
      process.stdout.write('{"type":"a"}\\n{"ty');
      setTimeout(() => {
        process.stdout.write('pe":"b"}\\n{"type":"c"}\\n');
      }, 20);
    `;
    expect(await collect(options(script))).toEqual([
      '{"type":"a"}',
      '{"type":"b"}',
      '{"type":"c"}',
    ]);
  });

  it("yields a final line that has no trailing newline", async () => {
    const script = `process.stdout.write('one\\ntwo');`;
    expect(await collect(options(script))).toEqual(["one", "two"]);
  });

  it("delivers the prompt on stdin", async () => {
    const script = `
      let buf = "";
      process.stdin.on("data", (c) => { buf += c; });
      process.stdin.on("end", () => process.stdout.write(buf.length + "\\n"));
    `;
    expect(await collect(options(script, { input: "x".repeat(5000) }))).toEqual([
      "5000",
    ]);
  });

  it("raises a typed error when the binary does not exist", async () => {
    await expect(
      collect(options("", { binary: "definitely-not-a-real-binary-xyz" })),
    ).rejects.toBeInstanceOf(SubscriptionCliNotInstalledError);
  });

  it("surfaces stderr when the child exits non-zero", async () => {
    const script = `
      process.stderr.write("weekly limit reached");
      process.exit(3);
    `;
    await expect(collect(options(script))).rejects.toThrow(
      /exited with code 3[\s\S]*weekly limit reached/,
    );
  });

  it("maps a signed-out message to an auth error", async () => {
    const script = `
      process.stderr.write("Please run /login to authenticate");
      process.exit(1);
    `;
    // Classified as an auth failure (not a generic non-zero exit), and
    // the descriptor's own hint is what reaches the user.
    await expect(collect(options(script))).rejects.toThrow(
      /is not signed in\. log in/,
    );
  });

  it("stops the child when the caller aborts", async () => {
    const controller = new AbortController();
    // Emits one line, then would hang for a minute.
    const script = `
      process.stdout.write('{"type":"a"}\\n');
      setTimeout(() => {}, 60000);
    `;
    const lines: string[] = [];
    const started = Date.now();
    await expect(
      (async () => {
        for await (const line of streamCliCommand(
          options(script, { signal: controller.signal }),
        )) {
          lines.push(line);
          controller.abort();
        }
      })(),
    ).rejects.toThrow();
    expect(lines).toEqual(['{"type":"a"}']);
    // SIGTERM must land well before the child's own 60s timer.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("does not leak the child when the consumer abandons the iterator", async () => {
    const script = `
      process.stdout.write('{"type":"a"}\\n');
      setTimeout(() => {}, 60000);
    `;
    const iterator = streamCliCommand(options(script));
    const first = await iterator.next();
    expect(first.value).toBe('{"type":"a"}');
    // The generator's finally block is responsible for the kill.
    await iterator.return();
  });
});

/** A prompt well past the ~64 KiB pipe buffer, so the write cannot flush at once. */
const BIG_PROMPT = "x".repeat(1024 * 1024);

describe("streamCliCommand stdin", () => {
  it("maps a signed-out CLI that never read a 1 MiB prompt to an auth error", async () => {
    // Without an `error` listener on `child.stdin` the EPIPE from the
    // undrained write is an uncaught exception, and
    // `installGlobalErrorHandlers` keeps that fatal — the operator loses
    // the session instead of being told to run /login.
    const script = `
      process.stderr.write("Please run /login to authenticate", () => process.exit(1));
    `;
    await expect(
      collect(options(script, { input: BIG_PROMPT })),
    ).rejects.toBeInstanceOf(SubscriptionCliAuthError);
  });

  it("survives an abort fired while a 1 MiB prompt is still draining", async () => {
    // Ctrl+C in the TUI: onAbort -> stop("abort") -> SIGTERM lands on a
    // child that has not read its stdin, so the pending write faults.
    const controller = new AbortController();
    const script = `
      process.stdout.write('{"type":"a"}\\n');
      setTimeout(() => {}, 60000);
    `;
    const lines: string[] = [];
    await expect(
      (async () => {
        for await (const line of streamCliCommand(
          options(script, { input: BIG_PROMPT, signal: controller.signal }),
        )) {
          lines.push(line);
          controller.abort();
        }
      })(),
    ).rejects.toThrow();
    expect(lines).toEqual(['{"type":"a"}']);
  });

  it("refuses a run whose prompt was only half delivered, even on exit 0", async () => {
    // `codex` exits 0 even when it fails, so the exit code alone would
    // let a completion computed from a truncated prompt through.
    const script = `
      process.stdout.write('{"type":"a"}\\n', () => process.exit(0));
    `;
    await expect(collect(options(script, { input: BIG_PROMPT }))).rejects.toThrow(
      /stopped reading the prompt/,
    );
  });
});

describe("streamCliCommand SIGKILL escalation", () => {
  const strays: number[] = [];

  afterEach(() => {
    // Belt and braces: nothing this file spawns may outlive the suite.
    for (const pid of strays.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone, which is the point of the test
      }
    }
  });

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitUntilGone(pid: number, budgetMs: number): Promise<number> {
    const started = Date.now();
    while (Date.now() - started < budgetMs) {
      if (!alive(pid)) return Date.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return -1;
  }

  it("force-kills a child that traps SIGTERM instead of orphaning it", async () => {
    // The `finally` used to clear the SIGKILL timer `stop` had just
    // armed, so this child survived every abort — one orphan per
    // cancelled turn. It reports its own pid so the test can watch it.
    const script = `
      process.on("SIGTERM", () => {});
      process.stdout.write(process.pid + "\\n");
      setInterval(() => {}, 1000);
    `;
    const iterator = streamCliCommand(options(script));
    const first = await iterator.next();
    const pid = Number(first.value);
    expect(Number.isInteger(pid)).toBe(true);
    strays.push(pid);

    await iterator.return();
    // SIGTERM is ignored, so only the 2s escalation can end it.
    expect(alive(pid)).toBe(true);
    const tookMs = await waitUntilGone(pid, 8_000);
    expect(tookMs).toBeGreaterThanOrEqual(0);
  });
});
