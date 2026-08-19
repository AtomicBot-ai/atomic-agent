import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { SplashBanner } from "./splash-banner.js";

function strip(value: string): string {
  return value
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\]8;;[^]*/g, "");
}

function frameAt(columns: number, rows: number): string {
  const { lastFrame } = render(<SplashBanner size={{ columns, rows }} />);
  return strip(lastFrame() ?? "");
}

describe("SplashBanner", () => {
  it("renders the plus-mark middle bar and the wordmark on a roomy surface", () => {
    const frame = frameAt(96, 40);
    // Middle bar of the plus — longest uninterrupted `:` run in the art.
    expect(frame).toContain("::::::::::::::::::::::::::::::::::");
    // Both halves of the `ATOMIC AGENT` half-block wordmark.
    expect(frame).toContain("▄▀█ ▀█▀ █▀█");
    expect(frame).toContain("▄▀█ █▀▀ █▀▀");
    expect(frame).toContain("Local AI-First Agent");
  });

  it("advertises the core slash commands and hotkeys", () => {
    const frame = frameAt(96, 40);
    expect(frame).toContain("/help");
    expect(frame).toContain("/sessions");
    expect(frame).toContain("/new");
    expect(frame).toContain("/model");
    expect(frame).toContain("/tasks");
    expect(frame).toContain("/import");
    expect(frame).toContain("Ctrl+C");
  });

  it("keeps the most useful tips when the surface is too short for all of them", () => {
    const frame = frameAt(96, 16);
    expect(frame).toContain("/help");
    expect(frame).toContain("/sessions");
    // The tail of the list is what gives way first.
    expect(frame).not.toContain("/import");
  });

  it("swaps in terse descriptions on a narrow surface", () => {
    const frame = frameAt(44, 20);
    expect(frame).toContain("/help");
    expect(frame).toContain("all commands");
    expect(frame).not.toContain("list all slash commands");
  });

  it("still shows a brand mark and a tip on a 40x12 window", () => {
    const frame = frameAt(38, 4);
    expect(frame).toContain("+ ATOMIC AGENT");
    expect(frame).toContain("Enter");
  });

  it("measures the terminal itself when no size is given", () => {
    const { lastFrame } = render(<SplashBanner />);
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain(":::");
    expect(frame).toContain("/help");
  });
});
