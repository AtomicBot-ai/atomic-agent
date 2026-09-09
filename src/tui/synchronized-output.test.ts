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

/**
 * What an incremental repaint of a single line looks like on the wire:
 * move the cursor onto the line, write it, erase to end of line. The last
 * line of a fullscreen frame carries no trailing newline.
 *
 * Constructed, not captured: no real repaint this small has been
 * observed (see the note on `looksLikeFrame` — the smallest measured was
 * 189 bytes, at the smallest window the TUI renders in). It pins the
 * predicate, which is "erases a line, therefore repainting", against the
 * length of any particular frame.
 */
const LINE_REPAINT = "\u001B[2A\u001B[E\u001B[Gthinking \u00B7 3s\u001B[K";

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

  it("brackets a short incremental line repaint too", () => {
    const stdout = fakeStdout(true);
    const controller = enableSynchronizedOutput({ stdout, env: {} });
    stdout.write(LINE_REPAINT);
    controller.restore();

    expect(stdout.writes[0]).toBe(`${BSU}${LINE_REPAINT}${ESU}`);
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

  it("counts a short single-line incremental repaint", () => {
    // Short, and no newline - but it erases a line, so it is a repaint,
    // and a repaint has to reach the terminal inside one synchronized
    // update or it is exactly the tearing this module exists to stop.
    // Nothing this short has been seen on the wire; this pins the
    // predicate, not a reproduction.
    expect(LINE_REPAINT.length).toBeLessThan(64);
    expect(LINE_REPAINT).not.toContain("\n");
    expect(looksLikeFrame(LINE_REPAINT)).toBe(true);
  });

  it("does not count a bare mode toggle", () => {
    expect(looksLikeFrame("[?25h")).toBe(false);
    expect(looksLikeFrame("[?1049l")).toBe(false);
  });
});
