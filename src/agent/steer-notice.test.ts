import { describe, expect, it } from "vitest";
import { composeSteerNotice, formatSteerNotice } from "./steer-notice.js";

describe("formatSteerNotice", () => {
  it("carries the message text verbatim", () => {
    const out = formatSteerNotice(["stop and just summarise"]);
    expect(out).toContain("stop and just summarise");
  });

  it("tells the model the message may cancel what it was doing", () => {
    const out = formatSteerNotice(["never mind"]);
    expect(out).toMatch(/change or cancel/);
  });

  it("pluralises when several arrived in one step", () => {
    const out = formatSteerNotice(["one", "two"]);
    expect(out).toContain("2 new messages");
    expect(out).toContain("- one");
    expect(out).toContain("- two");
  });

  it("clips a huge paste and points at the full copy in the transcript", () => {
    const out = formatSteerNotice(["x".repeat(5000)]);
    expect(out.length).toBeLessThan(1000);
    expect(out).toContain("### conversation");
  });

  it("returns empty for no messages", () => {
    expect(formatSteerNotice([])).toBe("");
  });
});

describe("composeSteerNotice", () => {
  it("keeps an existing loop-detector notice and appends the steer below it", () => {
    const out = composeSteerNotice("### repeat detected: os.fs.read", ["stop"]);
    expect(out).toContain("### repeat detected: os.fs.read");
    expect(out).toContain("stop");
    expect(out!.indexOf("repeat detected")).toBeLessThan(out!.indexOf("stop"));
  });

  it("passes the existing notice through untouched when nothing was steered", () => {
    expect(composeSteerNotice("loop!", [])).toBe("loop!");
    expect(composeSteerNotice(undefined, [])).toBeUndefined();
  });

  it("is just the steer block when there was no prior notice", () => {
    const out = composeSteerNotice(undefined, ["go left"]);
    expect(out).toBe(formatSteerNotice(["go left"]));
  });
});
