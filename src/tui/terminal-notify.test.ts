import { describe, expect, it } from "vitest";
import {
  emitTerminalNotification,
  escapeAppleScript,
  formatTurnNotification,
  sanitizeNotificationText,
  shouldNotify,
} from "./terminal-notify.js";

const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);

describe("shouldNotify", () => {
  it("always pings a failure, however short the turn", () => {
    expect(
      shouldNotify({
        outcome: "failed",
        durationMs: 40,
        minDurationMs: 30_000,
      }),
    ).toBe(true);
  });

  it("stays quiet for a quick success", () => {
    // The bell that rings on "what is 2+2" is the bell nobody hears
    // when it matters.
    expect(
      shouldNotify({
        outcome: "completed",
        durationMs: 1_200,
        minDurationMs: 30_000,
      }),
    ).toBe(false);
  });

  it("pings a success the operator plausibly stopped watching", () => {
    expect(
      shouldNotify({
        outcome: "completed",
        durationMs: 30_000,
        minDurationMs: 30_000,
      }),
    ).toBe(true);
  });

  it("treats a cancel as an ordinary ending", () => {
    // The operator cancelled it: they were at the keyboard a moment ago
    // and do not need telling, unless it had been running a while.
    expect(
      shouldNotify({
        outcome: "cancelled",
        durationMs: 500,
        minDurationMs: 30_000,
      }),
    ).toBe(false);
    expect(
      shouldNotify({
        outcome: "cancelled",
        durationMs: 90_000,
        minDurationMs: 30_000,
      }),
    ).toBe(true);
  });
});

describe("formatTurnNotification", () => {
  it("leads with the outcome and carries the shape of the turn", () => {
    const note = formatTurnNotification({
      outcome: "completed",
      reason: "reply",
      stepCount: 7,
      durationMs: 95_000,
      workingDirName: "atomic-agent",
    });
    expect(note.title).toBe("atomic-agent: turn done");
    expect(note.body).toBe("reply · 7 steps · 1m35s · atomic-agent");
  });

  it("says failed when it failed", () => {
    const note = formatTurnNotification({
      outcome: "failed",
      reason: "provider unreachable",
      stepCount: 1,
      durationMs: 2_000,
    });
    expect(note.title).toBe("atomic-agent: turn failed");
    expect(note.body).toBe("provider unreachable · 1 step · 2s");
  });
});

describe("sanitizeNotificationText", () => {
  it("drops the bytes that would end or restart the sequence", () => {
    // A failure reason is model-adjacent text. A BEL in it would close
    // the OSC early and the rest would be printed into the frame; an
    // ESC would open a sequence of its own.
    const dirty = `boom${BEL}${ESC}[31mred${String.fromCharCode(0x9c)}`;
    const clean = sanitizeNotificationText(dirty);
    expect(clean).not.toContain(BEL);
    expect(clean).not.toContain(ESC);
    expect(clean).not.toContain(String.fromCharCode(0x9c));
    expect(clean).toContain("boom");
  });

  it("bounds the length", () => {
    expect(sanitizeNotificationText("x".repeat(500))).toHaveLength(160);
  });
});

describe("emitTerminalNotification", () => {
  it("writes an OSC 9 payload and a bare bell", () => {
    const writes: string[] = [];
    emitTerminalNotification((chunk) => writes.push(chunk), {
      title: "atomic-agent: turn done",
      body: "reply · 3 steps · 42s",
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe(
      `${ESC}]9;atomic-agent: turn done — reply · 3 steps · 42s${BEL}`,
    );
    expect(writes[1]).toBe(BEL);
  });

  it("does not throw when the stream refuses the write", () => {
    expect(() =>
      emitTerminalNotification(
        () => {
          throw new Error("EPIPE");
        },
        { title: "t", body: "b" },
      ),
    ).not.toThrow();
  });
});

describe("escapeAppleScript", () => {
  it("closes the two holes an AppleScript literal has", () => {
    // The body carries a turn's failure reason, which is
    // model-adjacent text. An unescaped quote ends the literal and the
    // rest of the sentence becomes AppleScript.
    expect(escapeAppleScript('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeAppleScript("back\\slash")).toBe("back\\\\slash");
  });

  it("escapes the backslash before the quote, not after", () => {
    // The wrong order turns an escaped quote back into a bare one.
    expect(escapeAppleScript('a\\"b')).toBe('a\\\\\\"b');
  });
});
