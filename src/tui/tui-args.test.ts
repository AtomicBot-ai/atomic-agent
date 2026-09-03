import { describe, expect, it } from "vitest";

import { nonInteractiveStdinError, parseTuiArgs, TUI_HELP } from "./tui-args.js";

describe("nonInteractiveStdinError", () => {
  it("refuses a piped stdin with an actionable sentence", () => {
    const message = nonInteractiveStdinError({ isTTY: undefined });
    expect(message).toContain("needs an interactive terminal");
    expect(message).toContain("atomic-agent run");
  });

  it("stays silent on a real terminal", () => {
    expect(nonInteractiveStdinError({ isTTY: true })).toBeNull();
  });

  it("defaults to the real process.stdin", () => {
    // Vitest workers run with piped stdio, so the default argument is the
    // non-TTY case — the exact environment the guard exists for.
    expect(nonInteractiveStdinError()).not.toBeNull();
  });
});

describe("parseTuiArgs", () => {
  it("still reports unknown flags as usage errors", () => {
    expect(parseTuiArgs(["--definitely-not-a-flag"])).toHaveProperty("error");
  });
});

describe("parseTuiArgs mouse flags", () => {
  it("defers to the config by default", () => {
    const parsed = parseTuiArgs([]);
    expect(parsed).toMatchObject({ mouse: null });
  });

  it("--no-mouse turns reporting off for the run", () => {
    expect(parseTuiArgs(["--no-mouse"])).toMatchObject({ mouse: false });
  });

  it("--mouse forces reporting on even when the config disabled it", () => {
    expect(parseTuiArgs(["--mouse"])).toMatchObject({ mouse: true });
  });

  it("advertises both flags in --help", () => {
    expect(TUI_HELP).toContain("--no-mouse");
    expect(TUI_HELP).toContain("--mouse");
  });
});

describe("parseTuiArgs --fake-update", () => {
  it("stays off by default", () => {
    expect(parseTuiArgs([])).toMatchObject({ fakeUpdateVersion: null });
  });

  it("captures the pretended version", () => {
    expect(parseTuiArgs(["--fake-update", "9.9.9"])).toMatchObject({
      fakeUpdateVersion: "9.9.9",
    });
  });

  it("tolerates a v-prefixed version, since releases are tagged that way", () => {
    expect(parseTuiArgs(["--fake-update", "v9.9.9"])).toMatchObject({
      fakeUpdateVersion: "9.9.9",
    });
  });

  it("refuses a missing or flag-shaped value", () => {
    expect(parseTuiArgs(["--fake-update"])).toHaveProperty("error");
    expect(parseTuiArgs(["--fake-update", "--no-mouse"])).toHaveProperty("error");
  });

  it("advertises the flag in --help", () => {
    expect(TUI_HELP).toContain("--fake-update");
  });
});
