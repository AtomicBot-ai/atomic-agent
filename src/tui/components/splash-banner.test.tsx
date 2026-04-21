import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { SplashBanner } from "./splash-banner.js";

function strip(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
}

describe("SplashBanner", () => {
  it("renders the plus-mark middle bar and the wordmark", () => {
    const { lastFrame } = render(<SplashBanner />);
    const frame = strip(lastFrame() ?? "");
    // Middle bar of the plus — longest uninterrupted `:` run in the art.
    expect(frame).toContain("::::::::::::::::::::::::::::::::::");
    // Both halves of the `ATOMIC AGENT` half-block wordmark.
    expect(frame).toContain("▄▀█ ▀█▀ █▀█");
    expect(frame).toContain("▄▀█ █▀▀ █▀▀");
    expect(frame).toContain("local operator agent");
  });

  it("advertises the core slash commands and hotkeys", () => {
    const { lastFrame } = render(<SplashBanner />);
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("/help");
    expect(frame).toContain("/sessions");
    expect(frame).toContain("/new");
    expect(frame).toContain("F2");
    expect(frame).toContain("Ctrl+C");
  });
});
