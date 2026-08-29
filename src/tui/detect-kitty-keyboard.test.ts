import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { detectKittyKeyboard } from "./detect-kitty-keyboard.js";

/**
 * This probe runs before Ink attaches, on the one stream every
 * keystroke and every mouse report arrives on. Getting its cleanup
 * wrong does not degrade anything — it makes the whole app
 * unresponsive.
 *
 * 0.3.3 shipped with an explicit `stdin.pause()` here, added so that
 * start-up type-ahead was not dropped. Node only auto-resumes a stream
 * that was never explicitly paused, so Ink attaching its own listener
 * did NOT undo it: keyboard and mouse were both dead for the life of
 * the process. These tests pin the stream state on every exit path.
 */
const CSI = String.fromCharCode(27) + "[";
const QUERY = CSI + "?u";
const REPLY = CSI + "?1u";

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = false;
  resumed = false;

  setRawMode(value: boolean): this {
    this.isRaw = value;
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

function deps(stdin: FakeStdin, stdout: FakeStdout, timeoutMs = 20) {
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new FakeStdout() as unknown as NodeJS.WriteStream,
    timeoutMs,
  };
}

describe("detectKittyKeyboard", () => {
  it("asks the terminal and reports support when it answers", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const probe = detectKittyKeyboard(deps(stdin, stdout, 500));
    stdin.emit("data", Buffer.from(REPLY));
    await expect(probe).resolves.toBe(true);
    expect(stdout.written).toBe(QUERY);
  });

  it("reports no support when the terminal stays silent", async () => {
    const stdin = new FakeStdin();
    await expect(
      detectKittyKeyboard(deps(stdin, new FakeStdout())),
    ).resolves.toBe(false);
  });

  it("never leaves the stream paused when it was flowing", async () => {
    // The 0.3.3 regression in one assertion: a paused stdin means no
    // keystroke and no mouse report ever reaches the app again.
    const stdin = new FakeStdin();
    stdin.paused = false;
    await detectKittyKeyboard(deps(stdin, new FakeStdout()));
    expect(stdin.paused).toBe(false);
  });

  it("leaves the stream paused when it started paused", async () => {
    const stdin = new FakeStdin();
    stdin.paused = true;
    await detectKittyKeyboard(deps(stdin, new FakeStdout()));
    expect(stdin.paused).toBe(true);
  });

  it("restores raw mode and removes its listener on every path", async () => {
    for (const answer of [true, false]) {
      const stdin = new FakeStdin();
      stdin.isRaw = false;
      const probe = detectKittyKeyboard(deps(stdin, new FakeStdout()));
      if (answer) stdin.emit("data", Buffer.from(REPLY));
      await probe;
      expect(stdin.isRaw).toBe(false);
      expect(stdin.listenerCount("data")).toBe(0);
    }
  });

  it("does nothing at all when stdin is not a TTY", async () => {
    const stdin = new FakeStdin();
    stdin.isTTY = false;
    const stdout = new FakeStdout();
    await expect(detectKittyKeyboard(deps(stdin, stdout))).resolves.toBe(false);
    expect(stdout.written).toBe("");
    expect(stdin.resumed).toBe(false);
  });
});
