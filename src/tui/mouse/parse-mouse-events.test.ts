import { describe, expect, it } from "vitest";
import { decodeMouseEvents } from "./parse-mouse-events.js";

const ESC = "\u001B";

/** SGR press/release report for the given button code at 1-based col/row. */
function sgr(code: number, column: number, row: number, press = true): string {
  return `${ESC}[<${code};${column};${row}${press ? "M" : "m"}`;
}

describe("decodeMouseEvents", () => {
  it("decodes a left-button press into 0-based coordinates", () => {
    const { events, text, rest } = decodeMouseEvents(sgr(0, 12, 3));
    expect(text).toBe("");
    expect(rest).toBe("");
    expect(events).toEqual([
      {
        kind: "press",
        button: "left",
        wheel: null,
        x: 11,
        y: 2,
        shift: false,
        alt: false,
        ctrl: false,
      },
    ]);
  });

  it("distinguishes release reports from presses", () => {
    const { events } = decodeMouseEvents(sgr(0, 1, 1, false));
    expect(events[0]?.kind).toBe("release");
    expect(events[0]?.button).toBe("none");
  });

  it("decodes middle and right buttons", () => {
    const { events } = decodeMouseEvents(sgr(1, 2, 2) + sgr(2, 2, 2));
    expect(events.map((event) => event.button)).toEqual(["middle", "right"]);
  });

  it("decodes wheel up and wheel down", () => {
    const { events } = decodeMouseEvents(sgr(64, 5, 5) + sgr(65, 5, 5));
    expect(events.map((event) => event.kind)).toEqual(["wheel", "wheel"]);
    expect(events.map((event) => event.wheel)).toEqual(["up", "down"]);
  });

  it("decodes modifier bits", () => {
    const { events } = decodeMouseEvents(sgr(0 + 4 + 8 + 16, 1, 1));
    expect(events[0]).toMatchObject({ shift: true, alt: true, ctrl: true });
  });

  it("handles coordinates past the 223-column legacy ceiling", () => {
    const { events } = decodeMouseEvents(sgr(0, 400, 260));
    expect(events[0]).toMatchObject({ x: 399, y: 259 });
  });

  it("keeps the keyboard bytes around a report intact", () => {
    const { events, text } = decodeMouseEvents(`a${sgr(0, 2, 2)}b`);
    expect(text).toBe("ab");
    expect(events).toHaveLength(1);
  });

  it("reassembles a report split across two chunks", () => {
    const whole = sgr(0, 30, 7);
    const first = decodeMouseEvents(whole.slice(0, 6));
    expect(first.events).toEqual([]);
    expect(first.text).toBe("");
    expect(first.rest).toBe(whole.slice(0, 6));
    const second = decodeMouseEvents(first.rest + whole.slice(6));
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ x: 29, y: 6 });
    expect(second.rest).toBe("");
  });

  it("passes a lone Escape through instead of buffering it", () => {
    const { events, text, rest } = decodeMouseEvents(ESC);
    expect(events).toEqual([]);
    expect(text).toBe(ESC);
    expect(rest).toBe("");
  });

  it("leaves non-mouse CSI sequences untouched", () => {
    const arrows = `${ESC}[A${ESC}[B${ESC}[Z`;
    const { events, text } = decodeMouseEvents(arrows);
    expect(events).toEqual([]);
    expect(text).toBe(arrows);
  });

  it("decodes the legacy X10 encoding so it is never typed as text", () => {
    const x10 = `${ESC}[M${String.fromCharCode(32, 32 + 10, 32 + 4)}`;
    const { events, text } = decodeMouseEvents(x10);
    expect(text).toBe("");
    expect(events[0]).toMatchObject({
      kind: "press",
      button: "left",
      x: 9,
      y: 3,
    });
  });

  it("buffers a truncated X10 report", () => {
    const partial = `${ESC}[M${String.fromCharCode(32)}`;
    const { events, rest } = decodeMouseEvents(partial);
    expect(events).toEqual([]);
    expect(rest).toBe(partial);
  });
});
