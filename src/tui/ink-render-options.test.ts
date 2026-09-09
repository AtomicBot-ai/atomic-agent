import { describe, expect, it } from "vitest";
import { buildInkRenderOptions } from "./ink-render-options.js";

const streams = {
  stdin: {} as NodeJS.ReadStream,
  stdout: {} as NodeJS.WriteStream,
  stderr: {} as NodeJS.WriteStream,
};

describe("buildInkRenderOptions", () => {
  it("renders incrementally", () => {
    // The whole point of the option: Ink's default rewrites every line
    // of the frame on every state change, and while a turn runs that is
    // a full-screen erase several times a second — visible as blinking
    // on any terminal without synchronized output. Losing this flag
    // silently brings the blink back, so it is pinned here.
    const options = buildInkRenderOptions({ ...streams, kittyKeyboard: false });
    expect(options.incrementalRendering).toBe(true);
  });

  it("keeps Ctrl+C for the app", () => {
    const options = buildInkRenderOptions({ ...streams, kittyKeyboard: false });
    expect(options.exitOnCtrlC).toBe(false);
  });

  it("enables the kitty protocol only when the terminal answered", () => {
    expect(
      buildInkRenderOptions({ ...streams, kittyKeyboard: false }).kittyKeyboard,
    ).toBeUndefined();
    expect(
      buildInkRenderOptions({ ...streams, kittyKeyboard: true }).kittyKeyboard,
    ).toEqual({
      mode: "enabled",
      flags: ["disambiguateEscapeCodes"],
    });
  });

  it("passes the streams through untouched", () => {
    const options = buildInkRenderOptions({ ...streams, kittyKeyboard: true });
    expect(options.stdin).toBe(streams.stdin);
    expect(options.stdout).toBe(streams.stdout);
    expect(options.stderr).toBe(streams.stderr);
  });
});
