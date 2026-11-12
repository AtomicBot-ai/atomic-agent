import { describe, expect, it } from "vitest";
import {
  INCREMENTAL_RENDERING,
  buildInkRenderOptions,
} from "./ink-render-options.js";

const streams = {
  stdin: {} as NodeJS.ReadStream,
  stdout: {} as NodeJS.WriteStream,
  stderr: {} as NodeJS.WriteStream,
};

describe("buildInkRenderOptions", () => {
  it("repaints only what changed, behind one switch", () => {
    // Ink 8 rewrote incremental rendering (ATO-648). The option follows
    // the single `INCREMENTAL_RENDERING` constant so falling back to
    // full-frame repaints stays a one-line change; the session-swap
    // measurement that turned it off under Ink 7 is in its comment.
    const options = buildInkRenderOptions({ ...streams, kittyKeyboard: false });
    expect(INCREMENTAL_RENDERING).toBe(true);
    expect(options.incrementalRendering).toBe(INCREMENTAL_RENDERING);
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
