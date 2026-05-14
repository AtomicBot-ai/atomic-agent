import { describe, expect, it } from "vitest";
import {
  extractMouseEvents,
  installMouseInput,
  parseMouseEvents,
} from "./mouse-input.js";

describe("parseMouseEvents", () => {
  it("returns no events for an empty stream", () => {
    expect(parseMouseEvents("")).toEqual([]);
  });

  it("parses a wheel-up press as wheel_up", () => {
    const events = parseMouseEvents("\u001B[<64;10;5M");
    expect(events).toEqual([{ type: "wheel_up", col: 10, row: 5 }]);
  });

  it("parses a wheel-down press as wheel_down", () => {
    const events = parseMouseEvents("\u001B[<65;42;7M");
    expect(events).toEqual([{ type: "wheel_down", col: 42, row: 7 }]);
  });

  it("ignores release events ('m') and click buttons", () => {
    const events = parseMouseEvents(
      "\u001B[<0;3;3M\u001B[<64;3;3m\u001B[<2;1;1M",
    );
    expect(events).toEqual([]);
  });

  it("handles multiple wheel events in one chunk", () => {
    const events = parseMouseEvents(
      "\u001B[<64;1;1M\u001B[<65;2;3M\u001B[<64;9;9M",
    );
    expect(events).toEqual([
      { type: "wheel_up", col: 1, row: 1 },
      { type: "wheel_down", col: 2, row: 3 },
      { type: "wheel_up", col: 9, row: 9 },
    ]);
  });

  it("ignores non-mouse ANSI sequences interleaved with mouse events", () => {
    const events = parseMouseEvents("\u001B[1;2H\u001B[<64;5;5M\u001B[2J");
    expect(events).toEqual([{ type: "wheel_up", col: 5, row: 5 }]);
  });
});

describe("extractMouseEvents", () => {
  it("strips every SGR mouse sequence from the cleaned output", () => {
    const { events, cleaned } = extractMouseEvents(
      "hello\u001B[<64;5;5Mworld\u001B[<65;1;1m!",
    );
    expect(events).toEqual([{ type: "wheel_up", col: 5, row: 5 }]);
    expect(cleaned).toBe("helloworld!");
  });

  it("strips click / drag / release events even when no MouseEvent is yielded", () => {
    // Buttons 0/1/2 are click events — we never want those forwarded
    // to the editor, even though we emit no event for them.
    const { events, cleaned } = extractMouseEvents(
      "x\u001B[<0;3;3M\u001B[<0;3;3my",
    );
    expect(events).toEqual([]);
    expect(cleaned).toBe("xy");
  });

  it("preserves regular keyboard input verbatim", () => {
    const { events, cleaned } = extractMouseEvents("hello world\n");
    expect(events).toEqual([]);
    expect(cleaned).toBe("hello world\n");
  });
});

describe("installMouseInput", () => {
  it("returns the source stdin unchanged when the streams are not TTYs", () => {
    const fakeStdin = {
      isTTY: false,
      on: () => fakeStdin,
      off: () => fakeStdin,
    } as unknown as NodeJS.ReadStream;
    const fakeStdout = {
      isTTY: false,
      write: () => true,
    } as unknown as NodeJS.WriteStream;
    const events: unknown[] = [];
    const controller = installMouseInput({
      stdin: fakeStdin,
      stdout: fakeStdout,
      onEvent: (event) => events.push(event),
    });
    expect(controller.stdin).toBe(fakeStdin);
    expect(events).toEqual([]);
    controller.stop();
  });
});
