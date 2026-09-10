import { describe, expect, it } from "vitest";
import { buildInkRenderOptions } from "./ink-render-options.js";

const streams = {
  stdin: {} as NodeJS.ReadStream,
  stdout: {} as NodeJS.WriteStream,
  stderr: {} as NodeJS.WriteStream,
};

describe("buildInkRenderOptions", () => {
  it("repaints the whole frame", () => {
    // Pinned as false, not merely absent. Ink's incremental renderer
    // anchors its line diff to the bottom of the previous frame, and a
    // session swap replaces the transcript, the rail and the meta bar
    // in one commit — after which the rail's background stops being
    // painted and the composer wears what the rail left behind. The
    // measurement is in the comment beside the option.
    const options = buildInkRenderOptions({ ...streams, kittyKeyboard: false });
    expect(options.incrementalRendering).toBe(false);
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
