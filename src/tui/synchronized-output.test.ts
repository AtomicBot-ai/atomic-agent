import { describe, expect, it } from "vitest";
import {
  enableSynchronizedOutput,
  looksLikeFrame,
} from "./synchronized-output.js";

const BSU = "\u001B[?2026h";
const ESU = "\u001B[?2026l";

/** A stdout stand-in that records exactly what reached the terminal. */
function fakeStdout(isTTY: boolean): NodeJS.WriteStream & { writes: string[] } {
  const writes: string[] = [];
  const stream = {
    isTTY,
    writes,
    write(chunk: unknown): boolean {
      writes.push(String(chunk));
      return true;
    },
  };
  return stream as unknown as NodeJS.WriteStream & { writes: string[] };
}

const FRAME = "\u001B[H\u001B[2Kline one\nline two\nline three\n";

describe("enableSynchronizedOutput", () => {
  it("wraps a frame in one write, not three", () => {
    // Three writes would put the stream's own chunking between a marker
    // and the frame it brackets — which is the thing this prevents.
    const stdout = fakeStdout(true);
    const controller = enableSynchronizedOutput({ stdout, env: {} });
    stdout.write(FRAME);
    controller.restore();

    expect(stdout.writes[0]).toBe(`${BSU}${FRAME}${ESU}`);
  });

  it("leaves short control sequences alone", () => {
    const stdout = fakeStdout(true);
    const controller = enableSynchronizedOutput({ stdout, env: {} });
    stdout.write("[?25l");
    controller.restore();

    expect(stdout.writes[0]).toBe("[?25l");
  });

  it("does nothing at all off a TTY", () => {
    // A pipe cannot tear, and the markers would be noise in a captured
    // log or a snapshot test.
    const stdout = fakeStdout(false);
    const controller = enableSynchronizedOutput({ stdout, env: {} });
    stdout.write(FRAME);
    controller.restore();

    expect(stdout.writes).toEqual([FRAME]);
  });

  it("honours the opt-out", () => {
    const stdout = fakeStdout(true);
    const controller = enableSynchronizedOutput({
      stdout,
      env: { ATOMIC_AGENT_NO_SYNC_OUTPUT: "1" },
    });
    stdout.write(FRAME);
    controller.restore();

    expect(stdout.writes).toEqual([FRAME]);
  });

  it("restores the original write, and closes any open update", () => {
    const stdout = fakeStdout(true);
    const controller = enableSynchronizedOutput({ stdout, env: {} });
    controller.restore();
    stdout.write(FRAME);

    // The trailing ESU is insurance: a crash between the markers would
    // otherwise leave the terminal holding its display.
    expect(stdout.writes[0]).toBe(ESU);
    expect(stdout.writes[1]).toBe(FRAME);
  });

  it("is safe to restore twice", () => {
    const stdout = fakeStdout(true);
    const controller = enableSynchronizedOutput({ stdout, env: {} });
    controller.restore();
    controller.restore();

    expect(stdout.writes.filter((w) => w === ESU)).toHaveLength(1);
  });

  it("does not clobber a patch installed after ours", () => {
    const stdout = fakeStdout(true);
    const controller = enableSynchronizedOutput({ stdout, env: {} });
    const later = ((chunk: unknown) => {
      stdout.writes.push(`later:${String(chunk)}`);
      return true;
    }) as NodeJS.WriteStream["write"];
    stdout.write = later;
    controller.restore();

    expect(stdout.write).toBe(later);
  });
});

describe("looksLikeFrame", () => {
  it("counts anything with a newline, or anything long", () => {
    expect(looksLikeFrame("a\nb")).toBe(true);
    expect(looksLikeFrame("x".repeat(65))).toBe(true);
  });

  it("does not count a bare mode toggle", () => {
    expect(looksLikeFrame("[?25h")).toBe(false);
    expect(looksLikeFrame("[?1049l")).toBe(false);
  });
});
