import { describe, expect, it } from "vitest";
import {
  INCREMENTAL_RENDERING,
  INCREMENTAL_RENDERING_ENV,
  buildInkRenderOptions,
  incrementalRenderingEnabled,
} from "./ink-render-options.js";

const streams = {
  stdin: {} as NodeJS.ReadStream,
  stdout: {} as NodeJS.WriteStream,
  stderr: {} as NodeJS.WriteStream,
};

describe("buildInkRenderOptions", () => {
  it("repaints the full frame until the session-swap measurement passes", () => {
    // Under Ink 7 incremental rendering lost the session rail's fill
    // after `ctrl+g n` (33 painted rows -> 1). Ink 8 rewrote that path,
    // but it stays off until scripts/tui-session-swap-paint.py prints
    // 33/33 with it forced on (ATO-648). Flipping the constant is the
    // one-line switch; this test is the reminder to update it with it.
    const options = buildInkRenderOptions({
      ...streams,
      kittyKeyboard: false,
      env: {},
    });
    expect(INCREMENTAL_RENDERING).toBe(false);
    expect(options.incrementalRendering).toBe(false);
  });

  it("forces incremental rendering on only for the measurement env var", () => {
    expect(incrementalRenderingEnabled({ [INCREMENTAL_RENDERING_ENV]: "1" })).toBe(true);
    expect(incrementalRenderingEnabled({ [INCREMENTAL_RENDERING_ENV]: "0" })).toBe(false);
    expect(incrementalRenderingEnabled({ [INCREMENTAL_RENDERING_ENV]: "" })).toBe(false);
    expect(incrementalRenderingEnabled({})).toBe(false);
    expect(
      buildInkRenderOptions({
        ...streams,
        kittyKeyboard: false,
        env: { [INCREMENTAL_RENDERING_ENV]: "1" },
      }).incrementalRendering,
    ).toBe(true);
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
