import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Logo } from "./logo.js";

function strip(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
}

describe("Logo", () => {
  it("renders the plus-mark middle bar and the wordmark by default", () => {
    const { lastFrame } = render(<Logo />);
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("::::::::::::::::::::::::::::::::::");
    expect(frame).toContain("▄▀█ ▀█▀ █▀█");
    expect(frame).toContain("Local AI-First Agent");
  });

  it("hides the wordmark in compact mode", () => {
    const { lastFrame } = render(<Logo compact />);
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("::::::::::::::::::::::::::::::::::");
    expect(frame).not.toContain("▄▀█ ▀█▀ █▀█");
    expect(frame).not.toContain("Local AI-First Agent");
  });
});
