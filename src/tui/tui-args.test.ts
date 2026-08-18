import { describe, expect, it } from "vitest";

import { nonInteractiveStdinError, parseTuiArgs } from "./tui-args.js";

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
