import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  detectTerminalBackground,
  resolveStartupTheme,
  type DetectTerminalBackgroundDeps,
} from "./detect-terminal-background.js";
import { THEMES } from "./theme.js";

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  readonly rawCalls: boolean[] = [];
  paused = false;
  resumed = false;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    this.rawCalls.push(value);
    return this;
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.resumed = true;
    this.paused = false;
    return this;
  }
}

class FakeStdout {
  isTTY = true;
  written = "";

  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }
}

function deps(over: {
  stdin: FakeStdin;
  stdout: FakeStdout;
  stderr?: FakeStdout;
  timeoutMs?: number;
}): DetectTerminalBackgroundDeps {
  return {
    stdin: over.stdin as unknown as NodeJS.ReadStream,
    stdout: over.stdout as unknown as NodeJS.WriteStream,
    stderr: (over.stderr ?? new FakeStdout()) as unknown as NodeJS.WriteStream,
    ...(over.timeoutMs !== undefined ? { timeoutMs: over.timeoutMs } : {}),
  };
}

describe("detectTerminalBackground", () => {
  it("parses a 4-digit rgb: dark reply", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;rgb:0d0d/1111/1717\x07");
    expect(await promise).toBe("dark");
  });

  it("parses a #hex light reply", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;#ffffff\x07");
    expect(await promise).toBe("light");
  });

  it("scales a width-aware 2-digit rgb: channel (not zero) -> dark", async () => {
    // P6: naive `parseInt(x,16) >> 8` would yield 0 for "0d"; width-aware
    // scaling keeps it a real (dark) value.
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;rgb:0d/11/17\x07");
    expect(await promise).toBe("dark");
  });

  it("scales a 1-digit rgb: channel to full range -> light", async () => {
    // P6: "f" => 15/15*255 = 255 (white). Naive `>> 8` would give 0 (dark).
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;rgb:f/f/f\x07");
    expect(await promise).toBe("light");
  });

  it("accepts the ST (ESC backslash) terminator", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
    expect(await promise).toBe("light");
  });

  it("accumulates a reply split across two chunks (P3)", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;rgb:ffff/");
    stdin.emit("data", "ffff/ffff\x07");
    expect(await promise).toBe("light");
  });

  it("does not resolve early on an unterminated reply (P4), times out unknown", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout, timeoutMs: 20 }));
    // Complete color, but no BEL/ST terminator -> must not match.
    stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff");
    expect(await promise).toBe("unknown");
  });

  it("resolves before the timeout fires on a complete reply (P5)", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    // Large timeout: if it did not early-resolve the test would hang.
    const promise = detectTerminalBackground(
      deps({ stdin, stdout, timeoutMs: 10_000 }),
    );
    stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
    expect(await promise).toBe("dark");
  });

  it("resolves once under a handler+timeout race and removes the listener (P8)", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;#000000\x07");
    // A second, contradictory reply after resolution must be ignored.
    stdin.emit("data", "\x1b]11;#ffffff\x07");
    expect(await promise).toBe("dark");
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("captures and restores raw mode (was cooked) (P9)", async () => {
    const stdin = new FakeStdin();
    stdin.isRaw = false;
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;#000000\x07");
    await promise;
    expect(stdin.rawCalls).toEqual([true, false]);
    expect(stdin.isRaw).toBe(false);
  });

  it("restores a previously-raw stdin to raw (P9)", async () => {
    const stdin = new FakeStdin();
    stdin.isRaw = true;
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;#000000\x07");
    await promise;
    expect(stdin.rawCalls).toEqual([true, true]);
    expect(stdin.isRaw).toBe(true);
  });

  it("re-pauses stdin when it was paused before the probe (P10)", async () => {
    const stdin = new FakeStdin();
    stdin.paused = true;
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;#000000\x07");
    await promise;
    expect(stdin.paused).toBe(true);
  });

  it("leaves stdin flowing when it was not paused before the probe (P10)", async () => {
    const stdin = new FakeStdin();
    stdin.paused = false;
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;#000000\x07");
    await promise;
    expect(stdin.paused).toBe(false);
  });

  it("returns unknown and never touches raw mode on a non-TTY stdin (P1)", async () => {
    const stdin = new FakeStdin();
    stdin.isTTY = false;
    const stdout = new FakeStdout();
    const result = await detectTerminalBackground(deps({ stdin, stdout }));
    expect(result).toBe("unknown");
    expect(stdin.rawCalls).toEqual([]);
    expect(stdout.written).toBe("");
  });

  it("falls back to stderr when stdout is redirected (P2)", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    stdout.isTTY = false;
    const stderr = new FakeStdout();
    stderr.isTTY = true;
    const promise = detectTerminalBackground(deps({ stdin, stdout, stderr }));
    stdin.emit("data", "\x1b]11;#000000\x07");
    expect(await promise).toBe("dark");
    expect(stdout.written).toBe("");
    expect(stderr.written).not.toBe("");
  });

  it("returns unknown when no output stream is a TTY (P2)", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    stdout.isTTY = false;
    const stderr = new FakeStdout();
    stderr.isTTY = false;
    const result = await detectTerminalBackground(deps({ stdin, stdout, stderr }));
    expect(result).toBe("unknown");
    expect(stdin.rawCalls).toEqual([]);
  });

  it("times out to unknown when the terminal never replies (P5)", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const result = await detectTerminalBackground(
      deps({ stdin, stdout, timeoutMs: 20 }),
    );
    expect(result).toBe("unknown");
    expect(stdin.rawCalls).toEqual([true, false]);
  });

  it("returns unknown on a matched-but-unparseable reply (P11)", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;rgb:zz/zz/zz\x07");
    expect(await promise).toBe("unknown");
  });

  it("writes the OSC 11 query to the TTY output stream", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const promise = detectTerminalBackground(deps({ stdin, stdout }));
    stdin.emit("data", "\x1b]11;#000000\x07");
    await promise;
    expect(stdout.written).toBe("\x1b]11;?\x07");
  });
});

describe("resolveStartupTheme", () => {
  it("maps light to github-light", () => {
    expect(resolveStartupTheme("light")).toBe(THEMES["github-light"]);
  });

  it("maps dark to the house palette", () => {
    expect(resolveStartupTheme("dark")).toBe(THEMES["atomic-retro"]);
  });

  it("falls back unknown to the house palette", () => {
    // Unknown means the probe got no answer, which is most often a dark
    // terminal that does not answer OSC queries — so it lands where dark
    // lands rather than on the light palette.
    expect(resolveStartupTheme("unknown")).toBe(THEMES["atomic-retro"]);
  });
});
