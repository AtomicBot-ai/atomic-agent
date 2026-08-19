import { describe, expect, it } from "vitest";
import {
  createClipboardWriter,
  createNullClipboardWriter,
  fitsInOsc52,
  osc52Sequence,
  platformClipboardCommand,
  OSC52_MAX_BASE64_CHARS,
  type ClipboardCommandRunner,
} from "./copy-to-clipboard.js";

interface FakeStdout {
  isTTY: boolean;
  writes: string[];
  write(chunk: string): boolean;
}

function makeStdout(isTty: boolean): FakeStdout {
  const writes: string[] = [];
  return {
    isTTY: isTty,
    writes,
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
  };
}

interface RunLog {
  runner: ClipboardCommandRunner;
  calls: Array<{ command: string; args: readonly string[]; text: string }>;
}

function makeRunner(result: boolean): RunLog {
  const calls: RunLog["calls"] = [];
  return {
    calls,
    runner: async (command, args, text) => {
      calls.push({ command, args, text });
      return result;
    },
  };
}

describe("osc52Sequence", () => {
  it("wraps base64 in the OSC 52 clipboard sequence", () => {
    expect(osc52Sequence("hi")).toBe("\u001B]52;c;aGk=\u0007");
  });

  it("encodes non-ASCII as UTF-8 bytes, not UTF-16 units", () => {
    // A terminal decodes the payload as bytes; encoding "é" as its
    // UTF-16 code unit would paste a replacement character.
    expect(osc52Sequence("é")).toBe(
      `\u001B]52;c;${Buffer.from("é", "utf8").toString("base64")}\u0007`,
    );
  });

  it("carries newlines through untouched", () => {
    const decoded = Buffer.from(
      osc52Sequence("a\nb").slice("\u001B]52;c;".length, -1),
      "base64",
    ).toString("utf8");
    expect(decoded).toBe("a\nb");
  });
});

describe("fitsInOsc52", () => {
  it("accepts an ordinary chat message", () => {
    expect(fitsInOsc52("a normal reply")).toBe(true);
  });

  it("rejects a payload past the terminal-safe ceiling", () => {
    const tooBig = "x".repeat(OSC52_MAX_BASE64_CHARS);
    expect(fitsInOsc52(tooBig)).toBe(false);
  });
});

describe("platformClipboardCommand", () => {
  it("uses pbcopy on macOS", () => {
    expect(platformClipboardCommand("darwin", {})).toEqual({
      command: "pbcopy",
      args: [],
    });
  });

  it("uses clip on Windows", () => {
    expect(platformClipboardCommand("win32", {})?.command).toBe("clip");
  });

  it("prefers wl-copy over xclip when both sessions advertise themselves", () => {
    const command = platformClipboardCommand("linux", {
      WAYLAND_DISPLAY: "wayland-0",
      DISPLAY: ":0",
    });
    expect(command?.command).toBe("wl-copy");
  });

  it("falls back to xclip under X11", () => {
    expect(platformClipboardCommand("linux", { DISPLAY: ":0" })).toEqual({
      command: "xclip",
      args: ["-selection", "clipboard"],
    });
  });

  it("has nothing to offer on a headless box", () => {
    // Not a failure: OSC 52 is the correct — and only — route back to
    // the clipboard of whoever is on the other end of the ssh pipe.
    expect(platformClipboardCommand("linux", {})).toBeNull();
  });
});

describe("createClipboardWriter", () => {
  it("emits OSC 52 and runs the platform command for one copy", () => {
    const stdout = makeStdout(true);
    const run = makeRunner(true);
    const writer = createClipboardWriter({
      stdout,
      runCommand: run.runner,
      platform: "darwin",
      env: {},
    });
    return writer.copy("hello").then((ok) => {
      expect(ok).toBe(true);
      expect(stdout.writes).toEqual([osc52Sequence("hello")]);
      expect(run.calls).toEqual([
        { command: "pbcopy", args: [], text: "hello" },
      ]);
    });
  });

  it("still reports success when the platform command fails but OSC 52 went out", () => {
    // The SSH case: pbcopy would target the wrong machine anyway, and a
    // terminal that honoured OSC 52 has the text.
    const stdout = makeStdout(true);
    const run = makeRunner(false);
    const writer = createClipboardWriter({
      stdout,
      runCommand: run.runner,
      platform: "darwin",
      env: {},
    });
    return writer.copy("hello").then((ok) => expect(ok).toBe(true));
  });

  it("reports success from the platform command alone when the payload is too big for OSC 52", async () => {
    const stdout = makeStdout(true);
    const run = makeRunner(true);
    const writer = createClipboardWriter({
      stdout,
      runCommand: run.runner,
      platform: "darwin",
      env: {},
    });
    const huge = "x".repeat(OSC52_MAX_BASE64_CHARS);
    expect(await writer.copy(huge)).toBe(true);
    expect(stdout.writes).toEqual([]);
    expect(run.calls[0]?.text).toBe(huge);
  });

  it("reports failure when there is no platform command and the payload is too big", async () => {
    const stdout = makeStdout(true);
    const run = makeRunner(true);
    const writer = createClipboardWriter({
      stdout,
      runCommand: run.runner,
      platform: "linux",
      env: {},
    });
    expect(await writer.copy("x".repeat(OSC52_MAX_BASE64_CHARS))).toBe(false);
    expect(run.calls).toEqual([]);
  });

  it("does nothing at all when stdout is not a TTY", async () => {
    // This guard is what keeps `npx vitest` from overwriting the
    // clipboard of whoever is running the suite.
    const stdout = makeStdout(false);
    const run = makeRunner(true);
    const writer = createClipboardWriter({
      stdout,
      runCommand: run.runner,
      platform: "darwin",
      env: {},
    });
    expect(await writer.copy("hello")).toBe(false);
    expect(stdout.writes).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  it("falls back to the platform command when the stdout write throws", async () => {
    const run = makeRunner(true);
    const writer = createClipboardWriter({
      stdout: {
        isTTY: true,
        write: () => {
          throw new Error("EIO");
        },
      },
      runCommand: run.runner,
      platform: "darwin",
      env: {},
    });
    expect(await writer.copy("hello")).toBe(true);
    expect(run.calls).toHaveLength(1);
  });
});

describe("createNullClipboardWriter", () => {
  it("always reports failure", async () => {
    expect(await createNullClipboardWriter().copy("hello")).toBe(false);
  });
});
